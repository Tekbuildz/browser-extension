import {proxyAddress, proxyHostResolveParam, proxyHostResolvePath, proxyURLResolvePath} from "./proxy_handler.js";
import {addDnrRule} from "./dnr_handler.js";
import {policyCookie} from "./geofence_handler.js";
import {
    addRequest,
    addTabResource,
    clearTabResources,
    DOMAIN,
    getRequests,
    getSyncValue,
    GLOBAL_STRICT_MODE,
    MAIN_DOMAIN,
    PER_SITE_STRICT_MODE,
    SCION_ENABLED,
    type RequestSchema,
} from "../shared/storage.js";
import {normalizedHostname, safeHostname} from "../shared/utilities.js";
import type {WebNavigation, WebRequest} from "webextension-polyfill";

/**
 * Custom type, as the equivalent provided by the `webextension-polyfill` does not contain a `documentId`, even though both Firefox and Chromium support it.
 */
type OnCommittedDetailsType = {
    tabId: number
    url: string
    frameId: number
    transitionType: WebNavigation.TransitionType
    transitionQualifiers: WebNavigation.TransitionQualifier[]
    timeStamp: number
    documentId?: string | undefined
}
type OnBeforeRequestDetails = WebRequest.OnBeforeRequestDetailsType;
type OnHeadersReceivedDetails = WebRequest.OnHeadersReceivedDetailsType;
type OnAuthRequiredDetails = WebRequest.OnAuthRequiredDetailsType;
type OnErrorOccurredDetails = WebRequest.OnErrorOccurredDetailsType;

/**
 * General request interception concept:
 * - hosts unknown to the extension are forwarded to the proxy
 * - the proxy returns either a 503 if the host is not SCION-capable or a 301 (redirect to the resource) otherwise
 * - this return value can be detected and intercepted in the `onHeadersReceived` function
 */
export function initializeRequestInterceptionListeners() {
    browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, {urls: ["<all_urls>"]});

    browser.webRequest.onHeadersReceived.addListener(onHeadersReceived, {urls: ["<all_urls>"]});

    // in manifest version 3 (MV3), the onAuthRequired is the only listener that still supports and accepts the 'blocking' extraInfoSpec
    browser.webRequest.onAuthRequired.addListener(onAuthRequired, {urls: ["<all_urls>"]}, ['blocking']);

    browser.webRequest.onErrorOccurred.addListener(onErrorOccurred, {urls: ["<all_urls>"]});

    browser.webNavigation.onCommitted.addListener(onCommitted);
}

export async function isHostScion(hostname: string, initiator: string, currentTabId: number, alreadyHasLock = false) {
    let scionEnabled = false;

    const fetchUrl = `${proxyAddress}${proxyHostResolvePath}?${proxyHostResolveParam}=${hostname}`;
    const response = await fetch(fetchUrl, {method: "GET"});
    if (response.ok) {
        const text = await response.text();
        // the response text contains the SCION ISD path, or an empty string if the host is not
        // reachable through SCION
        scionEnabled = text !== "";

        // logging
        if (scionEnabled) console.log("[DB]: scion enabled (after resolve): ", hostname);
        else console.log("[DB]: scion disabled (after resolve): ", hostname);

        await handleAddDnrRule(hostname, scionEnabled, alreadyHasLock);
        await createRequestEntry(hostname, initiator, currentTabId, scionEnabled);
    } else {
        console.warn("[DB]: Resolution error: ", response.status);
    }

    console.log("[DB]: Resolution returned that host is scion-capable: ", scionEnabled);
    return scionEnabled;
}

// map that maps tabId to promises (which act as locks)
const perTabLocks = new Map<number, Promise<void>>();

function withTabLock(tabId: number, fn: (() => Promise<void>)) {
    const prev: Promise<void> = perTabLocks.get(tabId) ?? Promise.resolve();
    const next: Promise<void> = prev
        .catch(() => {
        })
        .then(fn)
        .finally(() => {
            if (perTabLocks.get(tabId) === next) perTabLocks.delete(tabId);
        });
    perTabLocks.set(tabId, next);
    return next;
}

// map that maps the tabId to a state (of type: { gen, topOrigin, currentDocumentId }
const tabState = new Map();

function safeProtocolFilteredHostname(url: string | URL) {
    try {
        const u = new URL(url);
        // ignore internal or otherwise undesired requests
        if (u.protocol === "chrome-extension:" || u.protocol === "moz-extension:" || u.protocol === "chrome:" || u.protocol === "about:" || u.protocol === "data:" || u.protocol === "blob:") {
            return null;
        }
        if (u.hostname) return normalizedHostname(u.hostname);
        return null;
    } catch {
        return null;
    }
}

function safeOrigin(url: string | URL) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function onCommitted(details: OnCommittedDetailsType) {
    if (details.tabId < 0) return;

    // this logic here most likely ignores iframes...
    if (details.frameId !== 0) return;

    withTabLock(details.tabId, async () => {
        const state = tabState.get(details.tabId) ?? {gen: 0, topOrigin: null, currentDocId: null};
        tabState.set(details.tabId, {
            ...state,
            topOrigin: safeOrigin(details.url),
            currentDocId: details.documentId ?? null,
        });
    });
}

function onBeforeRequest(details: OnBeforeRequestDetails): undefined {
    const tabId = details.tabId;
    if (tabId === browser.tabs.TAB_ID_NONE || tabId < 0) return;

    const hostname = safeProtocolFilteredHostname(details.url);
    if (!hostname) return;

    withTabLock(tabId, async () => {
        let state = tabState.get(tabId) ?? {gen: 0, topOrigin: null, currentDocId: null};

        // if a mainframe is detected, immediately reset the tab resources (since a new page was opened in an existing tab,
        // thus previous information should be removed)
        const globalStrictMode = await getSyncValue(GLOBAL_STRICT_MODE);
        if (details.type === "main_frame") {
            state = {gen: state.gen + 1, topOrigin: safeOrigin(details.url), currentDocId: null};
            tabState.set(tabId, state);
            // if global strict mode is on, clearing resources is handled by checking.html
            if (!globalStrictMode) await clearTabResources(tabId);

            // from testing, mainframe requests usually did not contain a documentId, onCommitted mainframe requests
            // however do, so we handle setting the new documentId in the onCommitted method as it is generally invoked
            // before onBeforeRequest anyway

            // additionally, mainframe requests also do not contain an initiator, thus we can return here already
            console.log(`[onBeforeRequest]: Got main_frame request for ${hostname}, resetting tab state: ${!globalStrictMode}.`, details);
            return;
        }

        // ignore requests if the documentId does not match the one observed in onCommitted
        // If the case (was never the case in testing) should occur where onCommitted is invoked after a subresource
        // invokes onBeforeRequest, it is currently ignored. A future fix would be keep a buffer of non-matching requests.
        // Due to results from testing and simplicity (since this is purely for UI information), it was left out for now.
        const docId = null; // TODO: firefox only supports documentUrl, which looks like it might be a replacement
        const currentDocId = state.currentDocId;

        // note that the two following if-statements are intentionally left empty for improved structure/documentation
        if (currentDocId && docId && docId === currentDocId) {
            // accept and handle request if the documentId matches the committed documentId stored in the state
        } else if (currentDocId && !docId && state.topOrigin && details.initiator === state.topOrigin) {
            // fallback solution in case a request does not contain a documentId at all:
            // if the initiator matches the url that was present in the onCommitted call of the mainframe, that is
            // also accepted and handled
        } else {
            // reject cases where the documentId and initiator do not match
            console.log("[onBeforeRequest]: Seems to be a request unrelated to the current tab: ", details);
            return;
        }

        // ===== CREATE TAB RESOURCES ENTRY =====
        const perSiteStrictMode = (await getSyncValue(PER_SITE_STRICT_MODE)) || {};

        const requests = await getRequests();
        const hostnameScionEnabled = requests.find((request) => request.domain === hostname)?.scionEnabled;

        const initiatorHostname = safeHostname(details.initiator!);
        if (initiatorHostname === null) {
            console.error("[onBeforeRequest]: Failed to extract hostname from initiator in: ", details);
            return;
        }

        // mainframe requests are already handled above and cannot reach this code, thus it is safe to assume that initiatorHostname exists
        if (globalStrictMode || perSiteStrictMode[initiatorHostname]) {
            // if it has not been discovered previously, ignore it since the DNR redirect rule will catch it
            // in strict mode and then perform the lookup (or in case of perSiteStrictMode, the lookup is already
            // performed if the user enters an unknown url there)
            if (hostnameScionEnabled === undefined) {
                console.log(`[onBeforeRequest]: Strict mode enabled and host '${hostname}' unknown, skipping to let redirect handle it.`);
                return;
            }

            console.log(`[onBeforeRequest]: Strict mode enabled, host '${hostname}' is known to be scion: ${hostnameScionEnabled}`);

            // however, for previously discovered hostnames, we do need to add the resource here manually, since
            // the higher-priority DNR rule will otherwise capture it and bypass the redirect-lookup-add chain
            await addTabResource(tabId, hostname, hostnameScionEnabled);

        } else {
            if (hostnameScionEnabled === undefined) {
                console.log(`[onBeforeRequest]: Strict mode disabled, host '${hostname}' is unknown, lookup is performed.`);

                // perform a lookup for the host, if it has not been discovered previously and strict mode is off
                await isHostScion(hostname, initiatorHostname ?? hostname, tabId);
                return;
            }

            console.log(`[onBeforeRequest]: Strict mode disabled, host '${hostname}' is known to be scion: ${hostnameScionEnabled}`);
            await addTabResource(tabId, hostname, hostnameScionEnabled);
        }
    });
}

// Skip answers on a resolve request with a status code 500 if the host is not scion capable
function onHeadersReceived(details: OnHeadersReceivedDetails): undefined {
    if (details.url.startsWith(`${proxyAddress}${proxyURLResolvePath}`)) {
        const url = new URL(details.url);
        // the actual URL that we need is in ?url=$url
        const target = url.search.split("=")[1];
        const targetHostname = normalizedHostname(new URL(target).hostname);

        // the proxy is expected to return a 503 if the host is not SCION-capable and 301 (redirect) otherwise
        if (details.statusCode !== 503 && details.statusCode !== 301) {
            console.error(`[onHeadersReceived]: Got an unexpected result from the proxy for host ${targetHostname}: `, details);
            return;
        }

        let scionEnabled = details.statusCode === 301;

        // logging
        if (scionEnabled) console.log("[onHeadersReceived]: scion enabled (after resolve): ", targetHostname);
        else console.log("[onHeadersReceived]: scion disabled (after resolve): ", targetHostname);

        asyncHelper().catch(reason => {
            console.error("[onHeadersReceived]: An error occurred during the creation of the DB entry or DNR rule: ", reason);
        });

        async function asyncHelper() {
            console.log("[onHeadersReceived]: ", details);
            const initiatorHostname = details.initiator ? safeHostname(details.initiator) : null;
            if (initiatorHostname === null) console.log("[onHeadersReceived]: Failed to extract hostname from initiator: ", details);
            await handleAddDnrRule(targetHostname, scionEnabled, false);
            await createRequestEntry(targetHostname, initiatorHostname ?? "", details.tabId, scionEnabled);
        }
    }
}

// Proxy requires the Proxy-Authorization header to be set,
// (if not it send back a Proxy-Authenticate header and triggers this function)
// the header has to contain the path policy cookie that is aquired by the first request
// and updated on setPolicy requests as there is no other way to pass the path policy into the
// Proxy for HTTPS requests (aka encrypted)
function onAuthRequired(details: OnAuthRequiredDetails) {
    console.log("<onAuthRequired>", details);
    console.log("PolicyCookie: ", policyCookie);

    let cookieInDisguise = ""
    if (policyCookie != null) {
        cookieInDisguise = policyCookie.name + "=" + policyCookie.value
    }

    return {
        authCredentials: {
            username: "policy", // garbage value
            password: cookieInDisguise // might be empty but this is fine as we only need a possibility to inject the path policy cookie
        }
    };
}

function onErrorOccurred(details: OnErrorOccurredDetails) {
    console.error("<onErrorOccurred>", details);
}

/**
 * Creates an entry in the requests list for the provided `hostname` and updates the tab resources with the `hostname`.
 */
async function createRequestEntry(hostname: string, initiator: string, currentTabId: number, scionEnabled: boolean) {
    const requestDBEntry: RequestSchema = {
        [DOMAIN]: hostname,
        [MAIN_DOMAIN]: initiator,
        [SCION_ENABLED]: scionEnabled,
    };

    await addRequest(requestDBEntry, {
        [DOMAIN]: requestDBEntry[DOMAIN],
        [MAIN_DOMAIN]: requestDBEntry[MAIN_DOMAIN],
        [SCION_ENABLED]: requestDBEntry[SCION_ENABLED],
    });

    if (currentTabId !== browser.tabs.TAB_ID_NONE) await addTabResource(currentTabId, hostname, scionEnabled);
}

/**
 * Checks whether `globalStrictMode` or `perSiteStrictMode` for the provided `hostname` are enabled and,
 * if either is true, adds the rule depending on whether `scionEnabled` for this host.
 */
async function handleAddDnrRule(hostname: string, scionEnabled: boolean, alreadyHasLock: boolean) {
    const globalStrictMode = await getSyncValue(GLOBAL_STRICT_MODE, false);
    const perSiteStrictMode = await getSyncValue(PER_SITE_STRICT_MODE, {});

    let strictHosts: string[] = [];
    if (perSiteStrictMode) {
        strictHosts = Object.entries(perSiteStrictMode)
            .filter(([_, isScion]: [string, boolean]) => isScion)
            .map(([host, _]: [string, boolean]) => host);
    }

    if (globalStrictMode || strictHosts.includes(hostname)) {
        await addDnrRule(hostname, scionEnabled, alreadyHasLock);
    }
}
