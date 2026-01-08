import {DOMAIN, getRequests, getSyncValue, GLOBAL_STRICT_MODE, PER_SITE_STRICT_MODE, type RequestSchema, type SyncValueSchema} from "../shared/storage.js";
import {proxyAddress, proxyHost, proxyURLResolveParam, proxyURLResolvePath, WPAD_URL} from "./proxy_handler.js";
import {isHostScion} from "./request_interception_handler.js";
import ResourceType = chrome.declarativeNetRequest.ResourceType;

type Rule = chrome.declarativeNetRequest.Rule;

/*
General DNR (DeclarativeNetRequest) strategy:
 - all `main_frame` resources are forwarded to a `checking.html` page where the extension
    can asynchronously verify whether the host is SCION capable. If it is, redirect to that
    resource, otherwise show a blocking-page
 - all other sub-resources are forwarded to the `/redirect` endpoint of the proxy and then
    handled by the `onHeadersReceived` function that, based on the returned statuscode, determines
    whether the host was scion capable (to prevent future requests from going to the proxy again)
 - for all hosts known to the extension, a DNR rule with higher priority is installed to
    override the generic redirect rules mentioned above, thus preventing proxy lookup loops (a
    hypothetical lookup loop example that assumes `example.com` is SCION-capable: user enters
    `example.com`, redirected to the proxy => proxy redirects to `example.com` => again redirected
    to the proxy etc.)

Regarding safety of functions:
The distribution of DNR rule IDs relies on first fetching the currently active rules, then
searching for an unused ID and using that in a call to `chrome.declarativeNetRequest.updateDynamicRules()`.
However, due to these calls being within an async function, there can be data races between
the fetch of active rules and the addition of a rule with the discovered unused ID, thus these
actions must be wrapped with `withLock`.
 */

// custom DNR rules (the ID simultaneously represents its priority)
const SUBRESOURCES_INITIATOR_REDIRECT_RULE_ID = 1;
const MAIN_FRAME_REDIRECT_RULE_ID = 2;
const SUBRESOURCES_REDIRECT_RULE_ID = 3;

// sufficiently high to have space for custom DNR rules (specified above)
const DOMAIN_SPECIFIC_RULES_START_ID = 10000;

const EXT_PAGE = chrome.runtime.getURL('/checking.html');

// extracting the hostname from the WPAD URL, as it needs to be excluded from matching rules
// note that this might cause other resources that share the same hostname to be excluded too
const WPAD_HOSTNAME = new URL(WPAD_URL).hostname;

const MAIN_FRAME_TYPE: ResourceType[] = [ResourceType.MAIN_FRAME];
const SUBRESOURCE_TYPES = [
    ResourceType.SUB_FRAME,
    ResourceType.XMLHTTPREQUEST,
    ResourceType.SCRIPT,
    ResourceType.IMAGE,
    ResourceType.FONT,
    ResourceType.MEDIA,
    ResourceType.STYLESHEET,
    ResourceType.OBJECT,
    ResourceType.OTHER,
    ResourceType.PING,
    ResourceType.WEBSOCKET,
    ResourceType.WEBTRANSPORT,
    ResourceType.WEBBUNDLE,
    ResourceType.CSP_REPORT,
];
const ALL_RESOURCE_TYPES =  MAIN_FRAME_TYPE.concat(SUBRESOURCE_TYPES);

/**
 * Initializes the DNR handler.
 *
 * Note that since this function is called from the service worker and these are ephemeral in MV3, this function will be called quite often (e.g. when the user opens a new tab).
 */
export async function initializeDnr(globalStrictMode: boolean) {
    console.log("Initializing DNR");

    await setGlobalStrictMode(globalStrictMode);
}

/**
 * Function that enforces the global strict mode based on the boolean value passed in `globalStrictMode` by
 * installing DNR rules.
 */
export async function setGlobalStrictMode(globalStrictMode: boolean) {
    if (globalStrictMode) {
        await withLock(async () => {
            const [allowedHostsWithId, blockedHostsWithId] = await getAllowedAndBlockedHostsWithId();

            let customRules = [
                createMainFrameRedirectRule(MAIN_FRAME_REDIRECT_RULE_ID),
                createSubResourcesRedirectRule(SUBRESOURCES_REDIRECT_RULE_ID),
            ];

            let domainSpecificRules = [];
            for (const [hostname, dnrRuleId] of Object.entries(allowedHostsWithId)) {
                domainSpecificRules.push(createAllowRule(hostname, dnrRuleId));
            }
            for (const [hostname, dnrRuleId] of Object.entries(blockedHostsWithId)) {
                domainSpecificRules.push(createBlockRule(hostname, dnrRuleId));
            }

            await updateRules(customRules, domainSpecificRules);
        });
    } else {
        // only handle perSiteStrictMode if global mode is off, otherwise global overrides them anyway
        // fallback to empty dictionary if no value was present in storage
        const perSiteStrictMode = await getSyncValue(PER_SITE_STRICT_MODE) || {};
        await setPerSiteStrictMode(perSiteStrictMode);
    }
}

/**
 * Updates the DNR rules to handle individual strict sites (which are based on the `perSiteStrictMode` parameter).
 */
export async function setPerSiteStrictMode(perSiteStrictMode: SyncValueSchema[typeof PER_SITE_STRICT_MODE]) {
    // if globalStrictMode is on, do not change any DNR rules
    const globalStrictMode = await getSyncValue(GLOBAL_STRICT_MODE, false);
    if (globalStrictMode) return;

    await withLock(async () => {
        const [allowedHostsWithId, blockedHostsWithId] = await getAllowedAndBlockedHostsWithId();

        const strictHosts: string[] = Object.entries(perSiteStrictMode)
            .filter(([, isStrict]) => isStrict)
            .map(([host]) => host);

        // adding rules that block each of the hosts directly
        let domainSpecificRules: Rule[] = [];
        for (const strictHost of strictHosts) {
            // if the extension has info about the host, add the appropriate DNR rule, otherwise perform a lookup
            if (Object.keys(blockedHostsWithId).includes(strictHost)) domainSpecificRules.push(createBlockRule(strictHost, blockedHostsWithId[strictHost]));
            else if (Object.keys(allowedHostsWithId).includes(strictHost)) domainSpecificRules.push(createAllowRule(strictHost, allowedHostsWithId[strictHost]));
            else {
                // using chrome.tabs.TAB_ID_NONE as the tab id, as no tab can be associated with this request
                // isHostScion already adds the appropriate DNR rules based on the lookup result (including creating the DB entry for the host)
                await isHostScion(strictHost, strictHost, chrome.tabs.TAB_ID_NONE, true);
            }
        }

        // the individual rules above are insufficient, as a site marked as 'strict' can invoke other sub-resources that
        // should be blocked, but might have a different hostname and thus might not have a matching rule
        // thus, a redirect rule is needed that redirects all requests whose initiator is marked as 'strict'
        let customRules = [];
        if (strictHosts.length > 0) {
            const subresourceInitiatorRule = createSubResourcesInitiatorRedirectRule(SUBRESOURCES_INITIATOR_REDIRECT_RULE_ID, strictHosts);
            customRules.push(subresourceInitiatorRule);
        }

        await updateRules(customRules, domainSpecificRules);
    });
}

/**
 * Based on `scionEnabled` creates a DNR allow or block rule for the `host`.
 */
export async function addDnrRule(host: string, scionEnabled: boolean, alreadyHasLock: boolean) {
    const run = async () => {
        const id = (await getNFreeIds(1))[0];
        const rule = scionEnabled ? createAllowRule(host, id) : createBlockRule(host, id);
        await chrome.declarativeNetRequest.updateDynamicRules({addRules: [rule], removeRuleIds: []})
    };
    if (alreadyHasLock) {
        await run();
        return;
    }
    await withLock(run);
}

/**
 * removes all DNR block rules, functionally equivalent to calling removeDNRBlockRule for each non-scion page
 */
export async function removeAllDnrBlockRules(customRulesToRemoveIds = null) {
    let rulesToRemoveIds;
    if (customRulesToRemoveIds !== null) rulesToRemoveIds = customRulesToRemoveIds;
    else {
        // get all currently active rules and assign them to be removed
        const currentRules = await chrome.declarativeNetRequest.getDynamicRules()
        rulesToRemoveIds = currentRules.map(rule => rule.id);
    }

    if (!rulesToRemoveIds || rulesToRemoveIds.length === 0) return;

    await chrome.declarativeNetRequest.updateDynamicRules({addRules: [], removeRuleIds: rulesToRemoveIds});
}

function createBlockRule(host: string, id: number): Rule {
    return {
        id: id,
        priority: 100,
        action: {type: 'block'},
        condition: {
            requestDomains: [host],
            resourceTypes: ALL_RESOURCE_TYPES
        }
    };
}

function createAllowRule(host: string, id: number): Rule {
    return {
        id: id,
        priority: 101,
        action: {type: 'allow'},
        condition: {
            requestDomains: [host],
            resourceTypes: ALL_RESOURCE_TYPES
        }
    }
}

/**
 * Returns a DNR rule that redirects all `main_frame` requests to the `checking.html` page for a synchronous blocking lookup.
 */
function createMainFrameRedirectRule(id: number): Rule {
    return {
        id: id,
        priority: id,
        action: {
            type: 'redirect',
            redirect: {
                // match entire URL and append it to a hash (separator character expected by checking.js)
                regexSubstitution: EXT_PAGE + '#\\0',
            },
        },
        condition: {
            regexFilter: '^.+$', // match any URL
            resourceTypes: MAIN_FRAME_TYPE
        }
    };
}

/**
 * Returns a DNR rule that redirects all sub-resources to the proxy `proxyURLResolvePath` endpoint.
 */
function createSubResourcesRedirectRule(id: number): Rule {
    return {
        id: id,
        priority: id,
        action: {
            type: 'redirect',
            redirect: {
                // pass entire URL to the proxy for lookup
                regexSubstitution: `${proxyAddress}${proxyURLResolvePath}?${proxyURLResolveParam}=\\0`,
            },
        },
        condition: {
            regexFilter: '^.+$', // match any URL
            resourceTypes: SUBRESOURCE_TYPES,
            // exclude requests from the proxy to prevent lookup-loops
            excludedRequestDomains: [
                proxyHost,
                WPAD_HOSTNAME,
            ],
        },
    };
}

/**
 * Returns a DNR rule that redirects all sub-resources whose initiator is in `blockedInitiators` to the `proxyURLResolvePath` endpoint.
 */
function createSubResourcesInitiatorRedirectRule(id: number, blockedInitiators: string[]): Rule {
    return {
        id: id,
        priority: id,
        action: {
            type: 'redirect',
            redirect: {
                // pass entire URL to the proxy for lookup
                regexSubstitution: `${proxyAddress}${proxyURLResolvePath}?${proxyURLResolveParam}=\\0`,
            },
        },
        condition: {
            regexFilter: '^.+$', // match any URL
            resourceTypes: SUBRESOURCE_TYPES,
            initiatorDomains: blockedInitiators,
            // exclude requests from the proxy to prevent lookup-loops
            excludedRequestDomains: [
                proxyHost,
                WPAD_HOSTNAME,
            ],
        }
    }
}

/**
 * Returns a tuple containing two maps, the first containing a mapping from scion-hostnames to their id,
 * the second containing a mapping from non-scion-hostnames to their id.
 *
 * Note that this function is unsafe and must be wrapped with `withLock`.
 */
async function getAllowedAndBlockedHostsWithId() {
    const requests: RequestSchema[] = await getRequests();
    let allowedHostsWithId: Record<string, number> = {};
    let blockedHostsWithId: Record<string, number> = {};
    const freeIds: number[] = await getNFreeIds(requests.length);

    let i: number = 0;
    for (const request of requests) {
        if (request.scionEnabled) allowedHostsWithId[request[DOMAIN]] = freeIds[i];
        else blockedHostsWithId[request[DOMAIN]] = freeIds[i];
        i++;
    }

    return [allowedHostsWithId, blockedHostsWithId];
}

/**
 * Returns `n` different IDs that are currently not in use by any DNR rule.
 *
 * Note that this function is unsafe and must be wrapped with `withLock`.
 */
async function getNFreeIds(n: number): Promise<number[]> {
    const currentRules: Rule[] = await chrome.declarativeNetRequest.getDynamicRules();
    const usedIds = new Set(currentRules.map(rule => rule.id));
    const idList = new Set(Array.from({length: n + usedIds.size}, (_, i) => i + DOMAIN_SPECIFIC_RULES_START_ID));
    return Array.from(idList.difference(usedIds));
}

/**
 * Updates the DNR rules with a single call to `chrome.declarativeNetRequest.updateDynamicRules` such that after execution of this function, only
 * `targetCustomRules` and `targetDomainSpecificRules` are active.
 *
 * @param targetCustomRules is an array of custom defined rules (such as `createMainFrameRedirectRule`) that should be active from this point onward.
 * @param targetDomainSpecificRules is an array of domain specific rules (created by `createBlockRule` and `createAllowRule`) that should be active from this point onward.
 */
async function updateRules(targetCustomRules, targetDomainSpecificRules) {
    const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
    let currentCustomRules = [];
    let currentDomainSpecificRules = [];
    for (const currentRule of currentRules) {
        if (currentRule.id < DOMAIN_SPECIFIC_RULES_START_ID) currentCustomRules.push(currentRule);
        else currentDomainSpecificRules.push(currentRule);
    }

    const customRulesToAdd = targetCustomRules.filter(rule => !currentCustomRules.includes(rule));
    const customRulesToRemove = currentCustomRules.filter(rule => !targetCustomRules.includes(rule));

    const currentDsrHosts = currentDomainSpecificRules.map(rule => rule.condition.requestDomains[0]);
    const targetDsrHosts = targetDomainSpecificRules.map(rule => rule.condition.requestDomains[0]);
    const domainSpecificRulesToAdd = targetDomainSpecificRules.filter(rule => !currentDsrHosts.includes(rule.condition.requestDomains[0]));
    const domainSpecificRulesToRemove = currentDomainSpecificRules.filter(rule => !targetDsrHosts.includes(rule.condition.requestDomains[0]));

    const rulesToAdd = customRulesToAdd.concat(domainSpecificRulesToAdd);
    const rulesToRemoveIds = customRulesToRemove.concat(domainSpecificRulesToRemove).map(rule => rule.id);
    await chrome.declarativeNetRequest.updateDynamicRules({addRules: rulesToAdd, removeRuleIds: rulesToRemoveIds});
}

/**
 * Lock to prevent data races when generating DNR rule IDs since access to `chrome.storage` is async.
 */
let idLock = Promise.resolve();

function withLock(fn: (() => Promise<void>)) {
    // chain the new work onto the previous one
    const p = idLock.then(fn, fn);
    // ensure errors don’t break the chain forever
    idLock = p.catch(() => {
    });
    return p;
}