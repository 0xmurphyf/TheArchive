// Real Sui Mainnet archival flow.
//
// This module replaces the previous simulated archiving with an actual on-chain
// call to `memory_archive::archive_forever`. Once an object is archived it is
// frozen forever (transfer::freeze_object) and can never be moved, edited, or
// recovered — so every UI path that calls this must warn the user first.

import { Transaction } from '@mysten/sui/transactions';
import { PACKAGE_ID } from './chain-archives.js';

const GRAPHQL_ENDPOINT = 'https://graphql.mainnet.sui.io/graphql';
// Mainnet v5 runtime package. Keep chain-archives.js on the canonical/original
// package ID for event type queries; transaction targets must use the published
// package that actually contains the v5 metadata validation.
const RUNTIME_PACKAGE_ID = '0x438eab12b59b366c113c54e864c34232c4514002043081747aff7a0de6c293f0';
const EVENT_PACKAGE_ID = '0x438eab12b59b366c113c54e864c34232c4514002043081747aff7a0de6c293f0';

// Enumerate the dynamic object fields (i.e. items) of a Kiosk object. Kiosk items
// are stored as dynamic fields on the Kiosk object keyed by item object id.
const KIOSK_FIELDS_QUERY = `
  query KioskFields($id: SuiAddress!, $cursor: String) {
    object(address: $id) {
      dynamicFields(first: 50, after: $cursor) {
        nodes {
          name { type { repr } json }
          value { ... on MoveObject { address } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const DENY_LIST_CONFIGS_QUERY = `
  query DenyListConfigs($cursor: String) {
    object(address: "0x403") {
      dynamicFields(first: 50, after: $cursor) {
        nodes { name { type { repr } json } value { ... on MoveObject { address } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const DENY_LIST_CONFIG_QUERY = `
  query DenyListConfig($id: SuiAddress!, $cursor: String) {
    object(address: $id) {
      dynamicFields(first: 50, after: $cursor) {
        nodes { name { type { repr } json } value { ... on MoveValue { json type { repr } } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function objectIdValue(value){
  if(typeof value==='string')return value;
  if(!value||typeof value!=='object')return '';
  return objectIdValue(value.id||value.ID||value.address||value.objectId||value.object_id);
}

function kioskCapabilityKind(type=''){
  if(/::kiosk::KioskOwnerCap(?:<|$)/.test(type))return 'standard-kiosk-owner-cap';
  if(/::personal_kiosk::PersonalKioskCap(?:<|$)/.test(type))return 'personal-kiosk-cap';
  return '';
}

function kioskCapabilityReference(value, depth=0){
  if(!value||typeof value!=='object'||depth>5)return null;
  if(value.for){
    const kioskId=objectIdValue(value.for);
    if(kioskId)return {kioskId,innerCapId:objectIdValue(value.id)||''};
  }
  for(const key of ['cap','fields','value','json','content']){
    const found=kioskCapabilityReference(value[key],depth+1);
    if(found)return found;
  }
  return null;
}

// Record every capability object owned by the connected wallet so the UI can
// persist the full capability inventory (not just the ones tied to a Kiosk we
// happen to enumerate). `data` is the flat object shape from listOwnedObjects.
const CAP_PATTERNS = [
  { re: /::kiosk::KioskOwnerCap(?:<|$)/, kind: 'KioskOwnerCap', ref: 'kiosk' },
  { re: /::personal_kiosk::PersonalKioskCap(?:<|$)/, kind: 'PersonalKioskCap', ref: 'kiosk' },
  { re: /::transfer_policy::TransferPolicyCap(?:<|$)/, kind: 'TransferPolicyCap', ref: 'policy' },
  { re: /::transfer_policy::TransferPolicy(?:<|$)/, kind: 'TransferPolicy', ref: 'policy' },
  { re: /::kiosk::Kiosk(?:<|$)/, kind: 'Kiosk', ref: 'kiosk' },
  { re: /::package::UpgradeCap(?:<|$)/, kind: 'UpgradeCap', ref: 'package' },
];
function collectCap(data) {
  const type = data?.type || data?.objectType || '';
  const match = CAP_PATTERNS.find((p) => p.re.test(type));
  if (!match) return null;
  const json = data?.json || data?.content?.json || data?.content?.fields || data?.content || {};
  const ref = kioskCapabilityReference(json) || kioskCapabilityReference(data);
  const cap = {
    kind: match.kind,
    objectId: data?.objectId || data?.data?.objectId,
    type,
    kioskId: match.ref === 'kiosk' ? (ref?.kioskId || json?.for || json?.id || null) : null,
    policyId: match.ref === 'policy' ? (ref?.kioskId || json?.id || json?.policy_id || null) : null,
    packageId: match.ref === 'package' ? (json?.package || null) : null,
    innerCapId: match.ref === 'kiosk' ? (ref?.innerCapId || null) : null,
  };
  // For the Kiosk object itself, read item_count / profits so the UI can flag
  // empty Kiosks that are safe to delete (Sui requires empty + 0 profits).
  if (match.kind === 'Kiosk') {
    const itemCount = Number(json?.item_count ?? json?.fields?.item_count ?? -1);
    const profits = BigInt(json?.profits ?? json?.fields?.profits ?? '0');
    cap.kioskItemCount = itemCount;
    cap.kioskProfits = profits.toString();
    cap.deletable = itemCount === 0 && profits === 0n;
  }
  return cap;
}

async function graphqlFetch(query, variables) {
  return withRetry(async () => {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Mainnet GraphQL returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(body.errors[0].message || 'Mainnet GraphQL query failed');
    return body.data;
  });
}

// Shared exponential-backoff retry for any Mainnet read/simulation that can fail
// transiently on the free public endpoints (429 rate-limit, 5xx, network blip,
// gRPC hiccup). Retries on thrown errors and on HTTP 429/5xx; does NOT retry on
// 4xx other than 429 (those are permanent client errors).
async function withRetry(fn, { attempts = 4, baseMs = 500, maxMs = 8000, retryDeterministic = false } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '').toLowerCase();
      const isTransient =
        /failed to fetch|network|timeout|abort|econnreset|etimedout|429|rate.?limit|5[0-9]{2}|grpc|unavailable|deadline|too many requests/i.test(message);
      const status = Number(error?.status || error?.response?.status || 0);
      const statusTransient = status === 429 || (status >= 500 && status < 600);
      // Deterministic client errors (bad arg types, missing fields) won't heal
      // on retry. When retryDeterministic is false we surface them immediately so
      // the user sees the real cause instead of waiting through dead retries.
      const isDeterministic = /commandargumenterror|type mismatch|argument|missing|not found|invalid|unknown object|abort/i.test(message);
      if (!isTransient && !statusTransient) {
        if (isDeterministic && !retryDeterministic) throw error;
        // Non-transient but non-deterministic (e.g. an unexpected shape): still
        // retry once in case it was a transient serialization glitch.
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(maxMs, baseMs) + Math.floor(Math.random() * 200)));
          continue;
        }
        throw error;
      }
      if (attempt + 1 < attempts) {
        const delay = Math.min(maxMs, baseMs * 2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// Authoritative lock check read directly from the Kiosk's dynamic fields.
// Mirrors the on-chain `kiosk::is_locked(id)` logic: an item is locked iff a
// `0x2::kiosk::Lock<T>` dynamic field exists for it. We never assume scan state.
const KIOSK_LOCK_QUERY = `
  query KioskLockCheck($id: SuiAddress!, $cursor: String) {
    object(address: $id) {
      dynamicFields(first: 50, after: $cursor) {
        nodes { name { type { repr } json } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export async function isKioskItemLocked(kioskId, itemId) {
  if (!kioskId || !itemId) return false;
  try {
    let cursor = null;
    const target = String(itemId).toLowerCase();
    do {
      const result = await graphqlFetch(KIOSK_LOCK_QUERY, { id: kioskId, cursor });
      const conn = result?.object?.dynamicFields;
      for (const node of conn?.nodes || []) {
        const repr = node?.name?.type?.repr || '';
        if (!/::kiosk::Lock(?:<|$)/.test(repr)) continue;
        const lockedId = objectIdValue(node?.name?.json);
        if (lockedId && String(lockedId).toLowerCase() === target) return true;
      }
      cursor = conn?.pageInfo?.hasNextPage ? conn?.pageInfo?.endCursor : null;
    } while (cursor);
    return false;
  } catch {
    // If we cannot verify, do not block — the chain will reject with EItemLocked
    // and the UI already explains that case.
    return false;
  }
}

function decodeDenyListKey(value){
  try{
    const binary=atob(String(value||''));
    return decodeURIComponent(Array.from(binary,c=>`%${c.charCodeAt(0).toString(16).padStart(2,'0')}`).join(''));
  }catch{return '';}
}
function coinTypeSuffix(type){
  const inner=String(type||'').match(/::Coin<(.+)>$/)?.[1]||String(type||'');
  const parts=inner.split('::');
  return parts.length>=2?`::${parts.at(-2)}::${parts.at(-1)}`:'';
}
async function fetchDeniedCoinSuffixes(address,coinTypes){
  if(!address||!coinTypes.length)return new Set();
  try{
    const epochResult=await graphqlFetch('{ epoch { epochId } }',{});
    const epoch=Number(epochResult?.epoch?.epochId??-1);
    const wanted=new Set(coinTypes.map(coinTypeSuffix).filter(Boolean));
    const configs=[]; let cursor=null;
    do{
      const result=await graphqlFetch(DENY_LIST_CONFIGS_QUERY,{cursor});
      for(const node of result?.object?.dynamicFields?.nodes||[]){
        const decoded=decodeDenyListKey(node?.name?.json?.per_type_key);
        const suffix=[...wanted].find(candidate=>decoded.endsWith(candidate));
        if(suffix&&node?.value?.address)configs.push({suffix,id:node.value.address});
      }
      const page=result?.object?.dynamicFields?.pageInfo;
      cursor=page?.hasNextPage?page.endCursor:null;
    }while(cursor);
    const blocked=new Set();
    for(const config of configs){
      let settingCursor=null;
      do{
        const result=await graphqlFetch(DENY_LIST_CONFIG_QUERY,{id:config.id,cursor:settingCursor});
        for(const node of result?.object?.dynamicFields?.nodes||[]){
          if(!/::deny_list::AddressKey$/.test(node?.name?.type?.repr||'')||String(node?.name?.json?.pos0||'').toLowerCase()!==address.toLowerCase())continue;
          const data=node?.value?.json?.data||{};
          if(data.older_value_opt===true||(data.newer_value===true&&Number(data.newer_value_epoch)<=epoch))blocked.add(config.suffix);
        }
        const page=result?.object?.dynamicFields?.pageInfo;
        settingCursor=page?.hasNextPage?page.endCursor:null;
      }while(settingCursor);
    }
    return blocked;
  }catch(error){console.debug('[owned-objects] Sui DenyList scan unavailable',error);return new Set();}
}

async function retryScanRequest(fn, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const POLICY_OBJECT_ID =
  '0x2241f042fe1119352e02dbc4869229f30e51a3dc3f546e09084a47bb6736e04d';
const CLOCK_OBJECT_ID = '0x6';
const STORAGE_NONE = 0;
const STORAGE_EXTERNAL = 1;
const STORAGE_IPFS = 2;
const STORAGE_ARWEAVE = 3;
const SOURCE_ORIGINAL = 0;
const SOURCE_ONLINE = 1;
const SOURCE_UPLOADED = 2;
const SUI_COIN_ICON_URL = '/archive-assets/sui-coin.svg';

// Helper: extract a readable object type + label from a Sui owned-object struct.
// Works with the gRPC client's `listOwnedObjects` shape (objects[].data/objectId/
// version/type/content) as well as the JSON-RPC `getOwnedObjects` shape.
// Derive a coin's display symbol from its Move type, e.g.
//  0x2::coin::Coin<...::suilfg_memefi::SUILFG_MEMEFI> -> "SUILFG_MEMEFI"
//  0x2::coin::Coin<0x2::sui::SUI>                    -> "SUI"
function coinSymbol(type) {
  const m = type.match(/::coin::Coin<(?:[^>]*::)?([^>]+)>$/);
  if (!m) return '';
  const last = m[1].split('::').pop();
  return last || '';
}

function ownerAddressOf(owner) {
  if (!owner) return '';
  if (typeof owner === 'string') return owner;
  return owner.AddressOwner || owner.address || owner.Address?.address || '';
}

function ownerObjectIdOf(owner){
  if(!owner||typeof owner!=='object')return '';
  return objectIdValue(owner.ObjectOwner||owner.objectOwner||owner.Object?.objectId||owner.object?.objectId);
}

function objectStateOf(data) {
  const owner = data?.owner;
  const ownerObjectId=ownerObjectIdOf(owner);
  if (owner?.Immutable || owner?.immutable) return { objectStatus: 'Immutable', ownershipStatus: 'Immutable', ownerAddress: '', ownerObjectId };
  if (owner?.Shared || owner?.shared) return { objectStatus: 'Shared', ownershipStatus: 'Shared', ownerAddress: '', ownerObjectId };
  const ownerAddress = ownerAddressOf(owner);
  if (ownerAddress) return { objectStatus: 'Owned', ownershipStatus: 'Owned', ownerAddress, ownerObjectId };
  return { objectStatus: 'Unknown', ownershipStatus: 'Unknown', ownerAddress: '', ownerObjectId };
}

function normalizeHash(value){
  if(Array.isArray(value))return value.length===32&&value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)?value:[];
  if(typeof value==='string'&&/^(0x)?[0-9a-fA-F]{64}$/.test(value)){
    const hex=value.replace(/^0x/,'');
    return Array.from({length:32},(_,index)=>Number.parseInt(hex.slice(index*2,index*2+2),16));
  }
  return [];
}

function normalizeImageUrl(value){
  const raw=String(value||'').trim();
  if(!raw)return '';
  try{
    const url=new URL(raw);
    if(url.protocol==='ipfs:'){
      const path=`${url.hostname}${url.pathname}`.replace(/^\/+/, '');
      return `https://ipfs.io/ipfs/${path}${url.search}`;
    }
    if(url.protocol==='walrus:'){
      const blobId=`${url.hostname}${url.pathname}`.replace(/^\/+/, '');
      return `https://aggregator.walrus.space/v1/blobs/${blobId}${url.search}`;
    }
  }catch{}
  return raw;
}

function describeObject(obj) {
  const data = obj?.data ?? obj;
  const state = objectStateOf(data);
  const rawContent = data?.json || data?.content || data?.contentJson || {};
  const contentJson = rawContent?.json || rawContent?.fields || rawContent;
  const fields = contentJson?.fields || contentJson;
  const artifactFields = fields?.artifact?.fields || fields?.artifact || {};
  const type = data?.type || data?.objectType || fields?.type || 'Unknown object';
  const isCoin = type.includes('::coin::Coin<') || type.includes('0x2::coin::Coin');
  // Fallback label for non-coins: last segment of the Move type (e.g.
  // 0x…::voxx::VoxxFile -> "VoxxFile"), so the Object Name row is never blank.
  const typeTail = type.split('::').pop().replace(/>$/, '');
  const name =
    fields.name ||
    (fields.artifact && fields.artifact.fields && fields.artifact.fields.name) ||
    (isCoin ? coinSymbol(type) : typeTail) ||
    '';
  const balanceRaw = fields.balance !== undefined ? fields.balance : contentJson?.balance;
  const display = data?.display?.output || data?.display?.data || data?.display || fields?.display?.output || fields?.display?.data || fields?.display || contentJson?.display?.output || contentJson?.display?.data || contentJson?.display || {};
  const displayFields = display?.data || display;
  const imageUrl=normalizeImageUrl(
    fields.image_url ||
    fields.imageUrl ||
    fields.media_url ||
    fields.mediaUrl ||
    fields.url ||
    artifactFields.image_url ||
    artifactFields.imageUrl ||
    artifactFields.url ||
    displayFields.image_url ||
    displayFields.imageUrl ||
    displayFields.url ||
    displayFields.image ||
    (isCoin && coinSymbol(type) === 'SUI' ? SUI_COIN_ICON_URL : '')
    || ''
  );
  const imageHash=normalizeHash(fields.image_hash||fields.imageHash||displayFields.image_hash||displayFields.imageHash);
  return {
    objectId: data.objectId,
    type,
    version: data.version,
    digest: data.digest,
    name: typeof name === 'string' ? name : '',
    isCoin,
    imageUrl,
    imageHash,
    exists: true,
    ...state,
    balance:
      balanceRaw !== undefined ? BigInt(balanceRaw) : undefined,
  };
}

// Returns true when the account is explicitly on Sui Mainnet. When chain
// metadata is unavailable (e.g. some injected wallets), allow the call to
// proceed and let the real Mainnet client validate the network.
function isMainnetAccount(account) {
  if (!account) return false;
  const chains = account.chains || [];
  if (chains.length === 0) return true;
  return chains.some((chain) => String(chain).toLowerCase().includes('mainnet'));
}

// Pull the objects the connected account actually owns. We fetch everything via
// `listOwnedObjects`, then for every distinct COIN type we call `listCoins`
// (passing the inner canonical coin type, e.g. `0x97…::suilfg_memefi::SUILFG_MEMEFI`)
// to obtain the real balance. listCoins is the only reliable source of `balance`
// with the gRPC read mask; `listOwnedObjects` does not populate `content`/`balance`
// for coins. This lets partial-amount archiving work for ANY coin type, not just SUI.
export async function fetchObjectById(client, objectId) {
  if (!client || !objectId) throw new Error('Object ID is required');
  const getObject = client.core?.getObject?.bind(client.core) || client.getObject?.bind(client);
  if (!getObject) throw new Error('Sui client cannot read objects');
  const include = client.core ? { json: true, display: true } : { content: true, display: true };
  return withRetry(async () => {
    const result = await getObject({ objectId, include });
    const object = result?.object ?? result?.data ?? result;
    const described = describeObject(object);
    if (!described.objectId || described.type === 'Unknown object') {
      throw new Error('Object metadata is unavailable');
    }
    return described;
  });
}

export async function preflightArchiveTransaction({ client, sender, ...params }) {
  if (!client || !sender) throw new Error('Mainnet client or sender is unavailable');
  // Resolve the real Kiosk cap type from chain so the archive PTB uses the
  // correct take path (standard vs PersonalKioskCap). Without this, a
  // PersonalKioskCap passed to standard kiosk::take aborts with
  // CommandArgumentError TypeMismatch at arg_idx 1.
  if (params.kioskId && params.kioskOwnerCapId && client) {
    let resolvedKind = kioskCapabilityKind(
      params.kioskCapKind === 'personal-kiosk-cap' ? '0x0::personal_kiosk::PersonalKioskCap' : ''
    );
    if (!resolvedKind) {
      try {
        const capObj = await fetchObjectById(client, params.kioskOwnerCapId);
        const capType = capObj?.object?.type || capObj?.data?.type || capObj?.type || '';
        resolvedKind = kioskCapabilityKind(capType);
      } catch {
        // fall back to the dataset hint below
      }
    }
    if (!resolvedKind) {
      resolvedKind = kioskCapabilityKind(
        params.kioskCapKind === 'personal-kiosk-cap'
          ? '0x0::personal_kiosk::PersonalKioskCap'
          : '0x0::kiosk::KioskOwnerCap'
      );
    }
    params.kioskCapKind = resolvedKind;
  }
  const tx = buildArchiveTransaction(params);
  tx.setSender(sender);
  tx.setGasBudget(100_000_000);
  // Free public endpoints intermittently fail tx.build (gRPC object reads) and
  // simulate; retry both (including deterministic errors) so a transient
  // serialization/resolve glitch gets a few attempts before we surface the cause.
  const bytes = await withRetry(() => tx.build({ client }), { attempts: 3, baseMs: 400, maxMs: 2000, retryDeterministic: true });
  const simulate = client.core?.simulateTransaction?.bind(client.core) || client.simulateTransaction?.bind(client);
  if (!simulate) return { success: true, unavailable: true, message: 'Simulation API unavailable; transaction build passed.' };
  const result = await withRetry(() => simulate({ transaction: bytes, include: { effects: true } }), { attempts: 3, baseMs: 400, maxMs: 2000, retryDeterministic: true });
  const status = result?.effects?.status || result?.Transaction?.status || result?.transaction?.effects?.status;
  const success = status?.success === true || status?.status === 'success' || result?.effects?.status === 'success';
  return { success, unavailable: false, message: status?.error || (success ? 'Preflight passed.' : 'Mainnet simulation did not pass.'), result };
}

export async function fetchOwnedObjects(client, address) {
  if (!client || !address) return [];

  const listOwned = client.core?.listOwnedObjects?.bind(client.core) || client.listOwnedObjects?.bind(client);
  const listCoins = client.core?.listCoins?.bind(client.core) || client.listCoins?.bind(client);
  const getCoinMetadata = client.core?.getCoinMetadata?.bind(client.core) || client.getCoinMetadata?.bind(client);
  const getObject = client.core?.getObject?.bind(client.core) || client.getObject?.bind(client);
  if (!listOwned) throw new Error('Sui client cannot list owned objects');
  const include = client.core ? { json: true, display: true } : { content: true, display: true };
  const collected = [];
  const caps = [];
  let scanIncomplete = false;
  let cursor = null;
  try {
    do {
      const result = await retryScanRequest(() => listOwned({ owner: address, cursor, limit: 100, include }));
      const page = result.objects || result.data || [];
      collected.push(...page);
      cursor = result.hasNextPage ? result.cursor : null;
    } while (cursor);
  } catch (error) {
    scanIncomplete = true;
    console.debug('[owned-objects] wallet object scan incomplete; keeping partial results', error);
  }

  const kioskItemContext = new Map();
  // Kiosk items are NOT returned by listOwnedObjects because the Kiosk owns them.
  // The connected account owns a KioskOwnerCap per kiosk; from each cap we read the
  // kiosk id, then enumerate the Kiosk object's dynamic object fields (GraphQL
  // `object(kioskId).dynamicFields`) to surface every item id. KioskOwnerCap is
  // intentionally excluded — it is a capability, not an archivable item.
  if (GRAPHQL_ENDPOINT && getObject) {
    try {
      const caps = collected
        .map((c) => (c?.data ?? c))
        .map((data) => ({ data, kind: kioskCapabilityKind(data?.type || data?.objectType || '') }))
        .filter((entry) => entry.kind);
      const kioskCapByKiosk = new Map();
      const ownedKiosks = collected
        .map((c) => (c?.data ?? c))
        .filter((d) => /::kiosk::Kiosk(?:<|$)/.test(d?.type || d?.objectType || ''));
      const kioskIds = new Set(ownedKiosks.map((kiosk) => kiosk?.objectId).filter(Boolean));
      for (const cap of caps) {
        const capData=cap.data;
        const content = capData?.json || capData?.content?.json || capData?.content?.fields || capData?.content || {};
        const reference=kioskCapabilityReference(content) || kioskCapabilityReference(capData);
        if (reference?.kioskId) {
          kioskIds.add(reference.kioskId);
          kioskCapByKiosk.set(reference.kioskId, {
            kind:cap.kind,
            capObjectId:capData?.objectId||'',
            innerCapId:reference.innerCapId||'',
            capOwner:address,
          });
        }
      }
      const seen = new Set(collected.map((c) => (c?.data ?? c)?.objectId));
      const scanKiosk = async (kioskId) => {
        let fieldCursor = null;
        const lockedItems = new Set();
        do {
          const result = await retryScanRequest(() => graphqlFetch(KIOSK_FIELDS_QUERY, { id: kioskId, cursor: fieldCursor }));
          const conn = result?.object?.dynamicFields;
          const nodes = conn?.nodes || [];
          await mapWithConcurrency(nodes, 8, async (node) => {
            const fieldType = node?.name?.type?.repr || '';
            if (/::kiosk::Lock(?:<|$)/.test(fieldType)) {
              const lockedId = objectIdValue(node?.name?.json);
              if (lockedId) {
                lockedItems.add(lockedId);
                const existing = kioskItemContext.get(lockedId) || {};
                kioskItemContext.set(lockedId, {
                  ...existing,
                  kioskId,
                  kioskOwnerCapId:kioskCapByKiosk.get(kioskId)?.capObjectId||existing.kioskOwnerCapId||'',
                  kioskCapKind:kioskCapByKiosk.get(kioskId)?.kind||existing.kioskCapKind||'',
                  kioskInnerCapId:kioskCapByKiosk.get(kioskId)?.innerCapId||existing.kioskInnerCapId||'',
                  kioskCapOwner:kioskCapByKiosk.get(kioskId)?.capOwner||existing.kioskCapOwner||'',
                  locked: true,
                });
              }
              return;
            }
            // Each kiosk item is a dynamic field whose value is the referenced
            // object. Non-object fields (e.g. `Lock`, `Extension`) have no value
            // address and are skipped.
            const itemId=objectIdValue(node?.value?.address||node?.value);
            if (!itemId || seen.has(itemId)) return;
            const existingItemContext=kioskItemContext.get(itemId);
            kioskItemContext.set(itemId, {
              kioskId,
              kioskOwnerCapId:kioskCapByKiosk.get(kioskId)?.capObjectId||existingItemContext?.kioskOwnerCapId||'',
              kioskCapKind:kioskCapByKiosk.get(kioskId)?.kind||existingItemContext?.kioskCapKind||'',
              kioskInnerCapId:kioskCapByKiosk.get(kioskId)?.innerCapId||existingItemContext?.kioskInnerCapId||'',
              kioskCapOwner:kioskCapByKiosk.get(kioskId)?.capOwner||existingItemContext?.kioskCapOwner||'',
              locked: Boolean(existingItemContext?.locked || lockedItems.has(itemId)),
            });
            try {
              const obj = await retryScanRequest(() => getObject({ objectId: itemId, include }));
              // gRPC getObject returns { object: <flat> }, JSON-RPC returns
              // { data: <flat> }; normalize to the flat object shape used by
              // the rest of this function and by describeObject.
              const o = obj?.object ?? obj?.data ?? obj;
              const objType = o?.type || o?.objectType || '';
              if (!/::kiosk::Kiosk(?:OwnerCap|Cap)(?:<|$)/.test(objType)) {
                collected.push(o);
                seen.add(itemId);
              }
            } catch (objErr) {
              throw new Error(`Kiosk item ${itemId} could not be loaded: ${objErr.message || objErr}`);
            }
          });
          fieldCursor = conn?.pageInfo?.hasNextPage ? conn?.pageInfo?.endCursor : null;
        } while (fieldCursor);
      };
      // Kiosks are independent; scan them concurrently while preserving every
      // page within each Kiosk. Any failed page rejects the full scan so the UI
      // never presents a silently incomplete NFT list.
      await Promise.all([...kioskIds].map(scanKiosk));
    } catch (error) {
      scanIncomplete = true;
      console.debug('[owned-objects] kiosk scan incomplete; keeping partial results', error);
    }
  }

  // Record every capability object owned by this wallet (KioskOwnerCap,
  // PersonalKioskCap, TransferPolicyCap, TransferPolicy, Kiosk, UpgradeCap),
  // independent of whether it is attached to an enumerated Kiosk. This gives the
  // UI a full, persisted inventory of the wallet's capabilities.
  for (const raw of collected) {
    const data = raw?.data ?? raw;
    const cap = collectCap(data);
    if (cap && cap.objectId) caps.push(cap);
  }

  const described = collected.map(describeObject).filter((o) => o.objectId && o.type !== 'Unknown object' && !/::kiosk::Kiosk(?:OwnerCap|Cap)(?:<|$)/.test(o.type) && !/::personal_kiosk::PersonalKioskCap(?:<|$)/.test(o.type)).map((object) => {
    const kiosk = typeof kioskItemContext === 'undefined' ? null : kioskItemContext.get(object.objectId);
    return kiosk
 ? { ...object, kiosk: true, inKiosk: true, locked: Boolean(kiosk.locked), kioskId: kiosk.kioskId, kioskOwnerCapId: kiosk.kioskOwnerCapId, kioskCapKind:kiosk.kioskCapKind||'', kioskInnerCapId:kiosk.kioskInnerCapId||'', kioskCapOwner:kiosk.kioskCapOwner||'', objectStatus: kiosk.locked ? 'Locked in Kiosk' : 'In Kiosk', ownershipStatus: kiosk.kioskCapKind === 'personal-kiosk-cap' ? 'Personal Kiosk' : (kiosk.locked ? 'Locked in Kiosk' : 'In Kiosk') }
      : { ...object, ownershipStatus: object.ownerAddress && object.ownerAddress.toLowerCase() === address.toLowerCase() ? 'Owned by connected wallet' : object.ownershipStatus };
  });
  const coins = described.filter((o) => o.isCoin);
  const nonCoins = described.filter((o) => !o.isCoin && o.objectId);

  // --- Real balances for every distinct coin type via listCoins ---
  // Extract the inner coin type (the part inside `0x2::coin::Coin<...>`) and
  // canonicalise each `0x`-segment (strip leading zeros) so listCoins matches.
  const innerTypeOf = (t) => {
    const m = t.match(/::Coin<(.+)>$/);
    return m ? m[1] : t;
  };
  const norm = (s) =>
    s
      .split('::')
      .map((seg) => (seg.startsWith('0x') ? seg.replace(/0x0+/, '0x') : seg))
      .join('::');

  const balanceByObject = new Map();
  const distinctTypes = [...new Set(coins.map((c) => norm(innerTypeOf(c.type))))];
  const denyListedSuffixes = await fetchDeniedCoinSuffixes(address, distinctTypes);
  if (listCoins) {
    for (const it of distinctTypes) {
      let c = null;
      try {
        do {
          const res = await retryScanRequest(() => listCoins({ owner: address, coinType: it, cursor: c, limit: 100 }));
          for (const obj of res.objects || []) {
            balanceByObject.set(
              obj.objectId,
              obj.balance !== undefined ? BigInt(obj.balance) : undefined,
            );
          }
          c = res.hasNextPage ? res.cursor : null;
        } while (c);
      } catch (error) {
        scanIncomplete = true;
        console.debug('[owned-objects] coin balance scan incomplete', it, error);
      }
    }
  }

  // Attach the fetched balance to each coin; non-coin objects pass through.
  // SUI falls back to the official Sui mark when no on-chain icon is available.
  const coinResults = await Promise.all(coins.map(async (o) => {
    let imageUrl=o.imageUrl;
    if(!imageUrl && getCoinMetadata){
      try{
        const innerType=norm(innerTypeOf(o.type));
        const metaResult=await getCoinMetadata({coinType:innerType});
        const meta=metaResult?.coinMetadata || metaResult?.metadata || metaResult || {};
        imageUrl=meta?.iconUrl || meta?.icon_url || meta?.icon || '';
      }catch(error){
        console.debug('[owned-objects] coin metadata unavailable', o.type, error);
      }
    }
    // Official Sui mark as the guaranteed fallback for SUI coins so the card
    // never shows a broken/empty image or a bare text glyph.
    if(!imageUrl && /::coin::Coin<[^>]*::sui::SUI\s*>/i.test(o.type)) imageUrl=SUI_COIN_ICON_URL;
    return {
      ...o,
      blocked: denyListedSuffixes.has(coinTypeSuffix(o.type)),
      imageUrl,
      balance: balanceByObject.has(o.objectId) ? balanceByObject.get(o.objectId) : o.balance,
    };
  }));

  const finalObjects=[...new Map([...coinResults, ...nonCoins].filter((o) => o.objectId).map((o) => [o.objectId, o])).values()];
  Object.defineProperty(finalObjects, 'scanIncomplete', { value: scanIncomplete, enumerable: false });
  Object.defineProperty(finalObjects, 'caps', { value: caps, enumerable: false });
  return finalObjects;
}

export async function fetchArchivePolicy(client) {
  if (!client) throw new Error('Sui client is unavailable');
  let result;
  let lastError;
  const readers = [
    client.core?.getObject?.bind(client.core),
    client.getObject?.bind(client),
  ].filter(Boolean);
  for (const read of readers) {
    try {
      result = await read({
        objectId: POLICY_OBJECT_ID,
        include: { json: true },
      });
      break;
    } catch (error) {
      lastError = error;
    }
    try {
      result = await read({
        id: POLICY_OBJECT_ID,
        options: { showContent: true },
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!result) throw lastError || new Error('Unable to read archive policy');
  const object = result?.object || result?.data || result;
  const json = object?.json || object?.content?.json || object?.content?.fields;
  const content = json || object?.content || result?.content || result?.data?.content;
  const fields = content?.fields || content;
  if (!fields || fields.archive_fee_mist === undefined) {
    throw new Error('Archive policy content is unavailable');
  }
  return {
    archiveFeeMist: BigInt(fields.archive_fee_mist),
    treasury: fields.treasury || '',
    version: Number(fields.version ?? 0),
  };
}

export async function fetchSuiBalance(client, address) {
  const result = await client.getBalance({ owner: address, coinType: '0x2::sui::SUI' });
  const total = result?.balance?.balance ?? result?.totalBalance ?? result?.balance ?? 0;
  return BigInt(total);
}

// Build a `Transaction` that archives the given owned object. The selected
// artifact is passed by reference (its ID), and Coin archives may split only
// the requested amount from that selected object. The gas coin is passed
// directly as the `&mut Coin<SUI>` payment required by the current Move ABI;
// the contract splits the configured fee internally and leaves the remainder
// in that gas coin.
export function buildArchiveTransaction({
  objectId,
  typeArgument,
  message,
  sealerSignature,
  sourceType = SOURCE_ORIGINAL,
  storageType = STORAGE_NONE,
  heroUri = '',
  heroHash = [],
  amount,
  kioskId,
  kioskOwnerCapId,
  kioskCapKind = '',
  gasPayment,
}) {
  const tx = new Transaction();

  const messageArg = tx.pure.string(String(message ?? '').slice(0, 16_382));
  const signatureArg = tx.pure.string(
    String(sealerSignature ?? '').slice(0, 16_382),
  );
  // image_url / image_hash are only meaningful when a real storage
  // backend is used. For STORAGE_NONE both must be empty (contract asserts this).
  const emptyUri = tx.pure.string(String(heroUri ?? ''));
  // The hash must be a 32-byte vector when storage != NONE; empty otherwise.
  const hashVector = Array.isArray(heroHash) && heroHash.length ? heroHash : [];
  const emptyHash = tx.pure.vector('u8', hashVector);
  const storageArg = tx.pure.u8(storageType);

  // `archive_forever` takes `payment` as `&mut Coin<SUI>` and does not consume
  // the payment object. Passing `tx.gas` directly matches the ABI; the Move
  // contract splits only the configured archive fee and retains the remainder.
  if (gasPayment?.objectId && gasPayment?.version !== undefined && gasPayment?.digest) {
    tx.setGasPayment([gasPayment]);
  }
  const payment = tx.gas;

  // The artifact: either the selected object, or — for a partial Coin archive —
  // a freshly split Coin of the requested amount. The split MUST come from the
  // selected coin object (objectId), NOT tx.gas — otherwise we'd freeze part of
  // the user's gas and leave the selected coin untouched. The remainder of the
  // selected coin stays with the user.
  let artifactArg;
  let typeArg = typeArgument;
  if (kioskId && kioskOwnerCapId && typeArgument) {
    // Kiosk items are owned by the Kiosk, not the wallet address. Take the
    // item into the transaction using the wallet's KioskOwnerCap, then pass
    // the returned object into archive_forever. The contract still remains
    // the final authority for the archive call.
    // A PersonalKioskCap wraps the KioskOwnerCap behind an Option, so standard
    // kiosk::take cannot read through it. Passing the raw PersonalKioskCap to
    // kiosk::take aborts with CommandArgumentError TypeMismatch at arg_idx 1 —
    // expose the inner cap via borrow_val first, exactly like the take-out flow.
    const isPersonal = kioskCapKind === 'personal-kiosk-cap';
    if (isPersonal) {
      const [cap, borrow] = tx.moveCall({
        target: `${PERSONAL_KIOSK_PACKAGE}::personal_kiosk::borrow_val`,
        arguments: [tx.object(kioskOwnerCapId)],
      });
      artifactArg = tx.moveCall({
        target: '0x2::kiosk::take',
        typeArguments: [typeArgument],
        arguments: [tx.object(kioskId), cap, tx.pure.id(objectId)],
      });
      tx.moveCall({
        target: `${PERSONAL_KIOSK_PACKAGE}::personal_kiosk::return_val`,
        arguments: [tx.object(kioskOwnerCapId), cap, borrow],
      });
    } else {
      artifactArg = tx.moveCall({
        target: '0x2::kiosk::take',
        typeArguments: [typeArgument],
        arguments: [
          tx.object(kioskId),
          tx.object(kioskOwnerCapId),
          tx.pure.id(objectId),
        ],
      });
    }
  } else if (amount !== undefined && amount !== null && typeArgument && typeArgument.includes('::coin::Coin<')) {
    const [coinType] = typeArgument.split('::Coin<');
    const fullCoinType = `${coinType}::Coin<${typeArgument.split('::Coin<')[1]}`;
    const split = tx.splitCoins(tx.object(objectId), [tx.pure.u64(String(amount))]);
    artifactArg = split[0];
    typeArg = fullCoinType;
  } else {
    artifactArg = tx.object(objectId);
  }

  const args = {
    target: `${RUNTIME_PACKAGE_ID}::memory_archive::archive_forever`,
    arguments: [
      tx.object(POLICY_OBJECT_ID), // shared ArchivePolicy
      artifactArg, // the artifact to archive (object or split coin)
      payment, // &mut Coin<SUI>; contract splits the configured fee
      messageArg,
      signatureArg,
      emptyUri,
      emptyHash,
      tx.pure.u8(sourceType),
      storageArg,
      tx.object(CLOCK_OBJECT_ID), // Clock
    ],
  };
  if (typeArg) args.typeArguments = [typeArg];

  tx.moveCall(args);

  return tx;
}

export async function estimateArchiveGas({
  client,
  objectId,
  typeArgument,
  sender,
  message = '',
  sealerSignature = '',
  sourceType = SOURCE_ORIGINAL,
  storageType = STORAGE_NONE,
  heroUri = '',
  heroHash = [],
  amount,
}) {
  if (!client?.core?.simulateTransaction || !sender) {
    throw new Error('Gas simulation is unavailable');
  }
  const tx = buildArchiveTransaction({
    objectId,
    typeArgument,
    message,
    sealerSignature,
    sourceType,
    storageType,
    heroUri,
    heroHash,
    amount,
  });
  tx.setSender(sender);
  tx.setGasBudget(50_000_000);
  const bytes = await tx.build({ client });
  const result = await client.core.simulateTransaction({
    transaction: bytes,
    include: { effects: true },
  });
  const gasUsed = result?.effects?.gasUsed;
  if (!gasUsed) throw new Error('Gas simulation returned no gas usage');
  const total = BigInt(gasUsed.computationCost || 0)
    + BigInt(gasUsed.storageCost || 0)
    + BigInt(gasUsed.nonRefundableStorageFee || 0)
    - BigInt(gasUsed.storageRebate || 0);
  if (total <= 0n) throw new Error('Gas simulation returned an invalid estimate');
  return total;
}
// Sign and execute via the connected dAppKit wallet on Mainnet.
const PERSONAL_KIOSK_PACKAGE = '0x0cb4bcc0560340eb1a1b929cabe56b33fc6449820ec8c1980d69bb98b649b802';
export async function archiveObject({
  client,
  dAppKit,
  objectId,
  typeArgument,
  message,
  sealerSignature,
  sourceType = SOURCE_ORIGINAL,
  storageType = STORAGE_NONE,
  heroUri = '',
  heroHash = [],
  amount,
  kioskId,
  kioskOwnerCapId,
  kioskCapKind = '',
  gasPayment,
}) {
  // Resolve the real capability type from chain state instead of trusting the
  // possibly-stale frontend dataset. A PersonalKioskCap passed to standard
  // kiosk::take aborts with CommandArgumentError TypeMismatch at arg_idx 1.
  let resolvedKind = kioskCapabilityKind(
    kioskCapKind === 'personal-kiosk-cap' ? '0x0::personal_kiosk::PersonalKioskCap' : ''
  );
  if (!resolvedKind && kioskOwnerCapId && client) {
    try {
      const capObj = await fetchObjectById(client, kioskOwnerCapId);
      const capType = capObj?.object?.type || capObj?.data?.type || capObj?.type || '';
      resolvedKind = kioskCapabilityKind(capType);
    } catch {
      // fall back to the dataset hint below
    }
  }
  if (!resolvedKind) {
    resolvedKind = kioskCapabilityKind(
      kioskCapKind === 'personal-kiosk-cap'
        ? '0x0::personal_kiosk::PersonalKioskCap'
        : '0x0::kiosk::KioskOwnerCap'
    );
  }
  const tx = buildArchiveTransaction({
    objectId,
    typeArgument,
    message,
    sealerSignature,
    sourceType,
    storageType,
    heroUri,
    heroHash,
    amount,
    kioskId,
    kioskOwnerCapId,
    kioskCapKind: resolvedKind,
    gasPayment,
  });
  const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
  return result;
}

// Expose the real on-chain API to the inline wizard script.
window.theArchiveTx = {
  PACKAGE_ID,
  EVENT_PACKAGE_ID,
  fetchOwnedObjects,
  fetchObjectById,
  preflightArchiveTransaction,
  buildArchiveTransaction,
  archiveObject,
  fetchArchivePolicy,
  estimateArchiveGas,
  fetchSuiBalance,
  isMainnetAccount,
  POLICY_OBJECT_ID,
  STORAGE_NONE,
  STORAGE_EXTERNAL,
  STORAGE_IPFS,
  STORAGE_ARWEAVE,
  SOURCE_ORIGINAL,
  SOURCE_ONLINE,
  SOURCE_UPLOADED,
};
