// Copyright 2024 ETH Zurich, Ovgu
'use strict';


import {getSyncValue, getSyncValues, getTabResources, GLOBAL_STRICT_MODE, PER_SITE_STRICT_MODE, PROXY_HOST, PROXY_PORT, PROXY_SCHEME, saveSyncValue, type SyncValueSchema} from "../shared/storage.js";
import {DEFAULT_PROXY_HOST, HTTPS_PROXY_PORT, HTTPS_PROXY_SCHEME, proxyHealthCheckPath, proxyPathUsagePath} from "../background_helpers/proxy_handler.js";
import {safeHostname} from "../shared/utilities.js";
import {getASName, getCountryCode, getCountryName, getFlagPath} from "./popup_helper.js";

export type PerDomainPathUsage = { Domain: string, Path: string[], Strategy: string };
type Tab = chrome.tabs.Tab;
type ProxyPathUsageResponse = PerDomainPathUsage[];

/**
 * Enum that represents the current status of the proxy.
 */
enum ProxyStatus {
    // Status determination has not finished yet
    Undetermined = 0,
    // HTTPS proxy was reached
    HTTPS = 1,
    // HTTPS proxy failed, but HTTP was reached
    HTTP = 2,
    // Both the HTTPS and HTTP proxy failed
    Failed = 3,
}

const DEFAULT_PROXY_SCHEME = HTTPS_PROXY_SCHEME;
const DEFAULT_PROXY_PORT = HTTPS_PROXY_PORT;

const popupTitle = document.getElementById("popupTitle") as HTMLHeadingElement;
const domainList = document.getElementById("domainlist") as HTMLDivElement;

// toggle-option for per-site strict mode of the current page
const togglePerSiteMainDomain = document.getElementById("togglePerSiteMainDomain") as HTMLDivElement;
const togglePerSiteContainer = document.getElementById("togglePerSiteContainer") as HTMLDivElement;
const togglePerSiteCheckbox = document.getElementById("togglePerSiteCheckbox") as HTMLInputElement;
const togglePerSiteMode = document.getElementById("togglePerSiteMode") as HTMLParagraphElement;

// path usage
const pathUsageSite = document.getElementById("pathUsageSite") as HTMLSpanElement;
const pathUsageStrategy = document.getElementById("pathUsageStrategy") as HTMLSpanElement;
const pathUsageISDs = document.getElementById("pathUsageISDs") as HTMLDivElement;
const pathUsagePath = document.getElementById("pathUsagePath") as HTMLDivElement;

// open options/preferences
const openOptionsButton = document.getElementById("openOptionsButton") as HTMLButtonElement;

// proxy status
const proxyContainer = document.getElementById("proxyContainer") as HTMLDivElement;
const proxyStatusMessage = document.getElementById('proxyStatusMessage') as HTMLSpanElement;
const proxyHelpLink = document.getElementById('proxyHelpLink') as HTMLAnchorElement;
const proxyDetailsContent = document.getElementById('proxyDetailsContent') as HTMLParagraphElement;

let proxyAddress = `${DEFAULT_PROXY_SCHEME}://${DEFAULT_PROXY_HOST}:${DEFAULT_PROXY_PORT}`
let perSiteStrictMode: SyncValueSchema[typeof PER_SITE_STRICT_MODE] = {};
let globalStrictMode: SyncValueSchema[typeof GLOBAL_STRICT_MODE] = false;
let popupMainDomain = "";

// TODO: after rebase, replace this with a call to initializeStrictModes
// initialization of the popup
getSyncValue(PER_SITE_STRICT_MODE, {}).then(async (result) => {
    perSiteStrictMode = result;
    await loadRequestInfo();
});
getSyncValue(GLOBAL_STRICT_MODE, false).then(async (result) => {
    globalStrictMode = result;
})
document.addEventListener("DOMContentLoaded", async () => {
    togglePerSiteCheckbox.addEventListener("click", togglePerSiteStrictModeOnClick);
    openOptionsButton.addEventListener("click", openOptionsButtonOnClick);

    const result = await getSyncValues({
        [PROXY_SCHEME]: DEFAULT_PROXY_SCHEME,
        [PROXY_HOST]: DEFAULT_PROXY_HOST,
        [PROXY_PORT]: DEFAULT_PROXY_PORT,
    });

    let proxyScheme = result[PROXY_SCHEME];
    let proxyHost = result[PROXY_HOST];
    let proxyPort = result[PROXY_PORT];
    proxyAddress = `${proxyScheme}://${proxyHost}:${proxyPort}`;

    checkProxyStatus();
});

/**
 * Checks the current reachability of the proxy and updates the visuals via {@link updateProxyStatusVisuals} accordingly.
 */
function checkProxyStatus() {
    updateProxyStatusVisuals(ProxyStatus.Undetermined);

    fetch(`${proxyAddress}${proxyHealthCheckPath}`, {
        method: "GET",
        signal: AbortSignal.timeout(2000)
    }).then(response => {
        if (response.status === 200) {
            if (proxyAddress.startsWith('https://')) {
                updateProxyStatusVisuals(ProxyStatus.HTTPS);
            } else {
                updateProxyStatusVisuals(ProxyStatus.HTTP);
            }
            proxyDetailsContent.textContent = `Proxy at ${proxyAddress}`;
        } else {
            updateProxyStatusVisuals(ProxyStatus.Failed);

            // Show error message for non-200 responses
            console.warn("Proxy check failed:", response.status);
        }
    }).catch(error => {
        updateProxyStatusVisuals(ProxyStatus.Failed);

        // Handle network errors or timeouts
        console.warn("Proxy check failed:", error);
    });
}

/**
 * Updates the UI based on the provided {@link proxyStatus}.
 */
function updateProxyStatusVisuals(proxyStatus: ProxyStatus) {
    const alertError = "alert-error";
    const alertWarning = "alert-warning";
    const alertSuccess = "alert-success";
    const backgroundGray = "bg-gray-300";

    switch (proxyStatus) {
        case ProxyStatus.Undetermined:
            proxyStatusMessage.textContent = "Checking proxy status...";
            proxyHelpLink.classList.add('hidden');

            proxyContainer.classList.remove(alertError, alertWarning, alertSuccess);
            proxyContainer.classList.add(backgroundGray);
            break;
        case ProxyStatus.HTTPS:
            proxyStatusMessage.textContent = "Connected to proxy via HTTPS";
            proxyHelpLink.classList.add('hidden');

            proxyContainer.classList.remove(alertError, alertWarning, backgroundGray);
            proxyContainer.classList.add(alertSuccess);
            break;
        case ProxyStatus.HTTP:
            proxyStatusMessage.textContent = "Connected to proxy via HTTP. Check help to connect via HTTPS.";

            proxyContainer.classList.remove(alertError, alertSuccess, backgroundGray);
            proxyContainer.classList.add(alertWarning);

            showProxyHelpLink();
            break;
        case ProxyStatus.Failed:
            proxyStatusMessage.textContent = "Failed to connect to proxy";
            proxyDetailsContent.textContent = `Proxy at ${proxyAddress}`;

            proxyContainer.classList.remove(alertWarning, alertSuccess, backgroundGray);
            proxyContainer.classList.add(alertError);

            showProxyHelpLink();
            break;
    }

    // handling display of icon
    for (let i = 0; i < 4; i++) {
        document.getElementById(`proxy-icon-${i}`)?.classList.add("hidden");
    }
    document.getElementById(`proxy-icon-${<number>proxyStatus}`)?.classList.remove("hidden");
}

function showProxyHelpLink() {
    proxyHelpLink.classList.remove('hidden');
    proxyHelpLink.href = chrome.runtime.getURL('proxy-help.html');

    proxyHelpLink.addEventListener('click', function (event) {
        event.preventDefault();
        chrome.tabs.create({url: this.href});
    });
}

/**
 * Updates the information displayed in the path-menu.
 */
function updatePathUsageVisuals(pathUsage: PerDomainPathUsage) {
    console.log("path usage: ", pathUsage);
    const isds: Set<number> = new Set(pathUsage.Path.map((v: string) => {
        const isd: string = v.split("-")[0];
        return Number.parseInt(isd);
    }));

    pathUsageSite.textContent = pathUsage.Domain;
    pathUsageStrategy.textContent = pathUsage.Strategy;
    pathUsageISDs.innerHTML = [...isds].map((isd: number) => {
        const countryCode = getCountryCode(isd);
        return `
            <div class="flex flex-row space-x-2 items-center">
                <img style="height: 25px" src=${getFlagPath(countryCode)} alt="Icon of ${getCountryName(countryCode)}"/>
                <p>(${countryCode})</p>
            </div>
        `
    }).join("");
    pathUsagePath.innerHTML = pathUsage.Path.map(ia => `
        <p>${ia} (${getASName(ia.split("-")[1])})</p>
    `).join("");
}

async function loadRequestInfo() {
    const tabs: Tab[] = await chrome.tabs.query({active: true, currentWindow: true});
    const activeTab: Tab = tabs[0];
    if (activeTab.url === undefined) {
        console.error("[Popup]: activeTab.url was undefined");
        return;
    }

    const hostname = safeHostname(activeTab.url);
    if (hostname === null) {
        console.error("[Popup]: error extracting hostname from url", activeTab.url);
        return;
    }
    popupMainDomain = hostname;

    const activeTabId = activeTab.id;
    if (activeTabId === undefined) {
        console.error("[Popup]: activeTabId was undefined for page with hostname: ", hostname);
        return;
    }

    const resources = await getTabResources(activeTabId) ?? [];
    const mainDomainSCIONEnabled = resources.some(resource => resource[0] === hostname && resource[1]);

    if (perSiteStrictMode[hostname]) {
        togglePerSiteMainDomain.innerHTML = hostname;
        togglePerSiteCheckbox.checked = true;
        togglePerSiteMode.textContent = "Strict";
    } else if (mainDomainSCIONEnabled) {
        togglePerSiteMainDomain.innerHTML = hostname;
        togglePerSiteCheckbox.checked = false;
        togglePerSiteMode.textContent = "When available";
    } else {
        togglePerSiteContainer.style.display = "none";
    }// TODO: Else case would be no SCION... toggleRunning.checked = false;

    let mixedContent = false
    for (const resource of resources) {
        const domain = resource[0];
        const scionEnabled = resource[1];

        const div = document.createElement("div");
        div.classList.add("badge", scionEnabled ? "badge-success" : "badge-error", "gap-2", "pt-3", "pb-3");

        if (scionEnabled) {
            div.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 stroke-current" fill="none" viewBox="0 0 24 24">`
                + `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M4 12l4 4 8-8"/>`
                + `</svg>`
                + domain;
        } else {
            div.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block h-4 w-4 stroke-current">`
                + `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>`
                + `</svg>`
                + domain;
            mixedContent = true;
        }

        domainList.appendChild(div);
    }

    if (perSiteStrictMode[hostname] || globalStrictMode) {
        if (mainDomainSCIONEnabled) {
            if (mixedContent) {
                popupTitle.innerHTML = "Strict mode prevented some resources from loading";
            } else {
                popupTitle.innerHTML = "All resources could be loaded";
            }
        } else {
            popupTitle.innerHTML = "Strict mode blocked the page";
        }
    } else {
        if (mainDomainSCIONEnabled) {
            if (mixedContent) {
                popupTitle.innerHTML = "Not all resources loaded via SCION";
            } else {
                popupTitle.innerHTML = "All resources loaded via SCION";
            }
        } else {
            popupTitle.innerHTML = "No resources loaded via SCION";
        }
    }

    // Update path usage for the current domain
    await updatePathUsage();
}

const updatePathUsage = async () => {
    console.log("get path usage")
    pathUsagePath.innerHTML = "";

    const response = await fetch(`${proxyAddress}${proxyPathUsagePath}`, {method: "GET"});
    if (response.status !== 200) return;

    const res = await response.json();
    const json = res as ProxyPathUsageResponse;
    console.log(json)
    if (!json || json.length === 0) {
        pathUsagePath.innerHTML = `
            <p>No path usage data available</p>
            <p>Try to configure your own policies to have access to path usage data (under <i>Manage Preferences</i>).</p>
        `;
        return;
    }

    json.forEach((pathUsage: PerDomainPathUsage) => {
        console.log(pathUsage.Domain.split(":")[0])
        // we only expect one match
        if (popupMainDomain && pathUsage.Domain.split(":")[0] === popupMainDomain) {
            updatePathUsageVisuals(pathUsage);
        }
    });

    if (pathUsagePath.innerHTML === "") {
        /*
        TODO: instead of setting this info here, set it directly when expanding the "Path", specifically:

        Instead of:
        Path Usage
        | Info (empty)
        | Path (text here)

        probably better do:
        Path Usage
        | (text here)

        or alternatively:
        (text here)
        Path Usage (display:none)
         */
        pathUsagePath.innerHTML = `
            <p>No path usage data available for ${popupMainDomain || "current domain"}</p>
            <p>Try to configure your own policies to have acces to path usage data (under <i>Manage Preferences</i>).</p>
        `;
        return;
    }
};

/**
 * Toggles the per-site strict-mode value for the currently open site.
 */
async function togglePerSiteStrictModeOnClick() {
    const newPerSiteStrictMode = {
        ...perSiteStrictMode,
        [popupMainDomain]: togglePerSiteCheckbox.checked,
    };

    if (togglePerSiteCheckbox.checked) {
        togglePerSiteMainDomain.innerHTML = popupMainDomain;
        togglePerSiteMode.innerHTML = "Strict";
    } else {
        togglePerSiteMainDomain.innerHTML = popupMainDomain;
        togglePerSiteMode.innerHTML = "When available";
    }

    await saveSyncValue(PER_SITE_STRICT_MODE, newPerSiteStrictMode);
    perSiteStrictMode = newPerSiteStrictMode;
}

/**
 * Opens the options page in a new tab.
 */
async function openOptionsButtonOnClick() {
    await chrome.tabs.create({'url': 'chrome://extensions/?options=' + chrome.runtime.id});
}