// Copyright 2024 ETH Zurich, Ovgu
'use strict';

import {initializeProxyHandler, loadProxySettings} from "./background_helpers/proxy_handler.js";
import {allowAllgeofence, geofence, resetPolicyCookie} from "./background_helpers/geofence_handler.js";
import {EXTENSION_RUNNING, getSyncValue, GLOBAL_STRICT_MODE, ISD_ALL, ISD_WHITELIST, PER_SITE_STRICT_MODE, saveSyncValue, type SyncValueSchema} from "./shared/storage.js";
import {globalStrictModeUpdated, initializeDnr, perSiteStrictModeUpdated, updateProxySettingsInDnrRules} from "./background_helpers/dnr_handler.js";
import {initializeRequestInterceptionListeners} from "./background_helpers/request_interception_handler.js";
import {initializeTabListeners} from "./background_helpers/tab_handler.js";
import {initializeStrictModes, setGlobalStrictMode, setPerSiteStrictMode} from "./shared/utilities.js";


/*--- setup ------------------------------------------------------------------*/

const initializeExtension = async () => {
    await initializeStrictModes();

    /*--- PAC --------------------------------------------------------------------*/
    // initializing proxy handler before DNR, as some DNR rules rely on the `proxyAddress`
    await initializeProxyHandler()
    /*--- END PAC ----------------------------------------------------------------*/

    await initializeDnr();
};
initializeExtension();

// Do icon setup etc at startup
getSyncValue(EXTENSION_RUNNING).then(async extensionRunning => {
    await updateRunningIcon(extensionRunning);
});

/*--- storage ----------------------------------------------------------------*/

chrome.storage.onChanged.addListener(async (changes, namespace) => {
    // In case we disable running for the extension, lets put an empty set for now
    // Later, we could remove the PAC script, but doesn't impact us now...
    if (namespace === "sync") {
        if (changes.extension_running?.newValue !== undefined) {

            await updateRunningIcon(changes.extension_running.newValue);

        } else if (changes.isd_all?.newValue !== undefined) {

            const isdAll = changes.isd_all.newValue as SyncValueSchema[typeof ISD_ALL];
            allowAllgeofence(isdAll);

        } else if (changes.isd_whitelist?.newValue) {

            const isdWhitelist = changes.isd_whitelist.newValue as SyncValueSchema[typeof ISD_WHITELIST];
            geofence(isdWhitelist);

        } else if (changes.perSiteStrictMode?.newValue !== undefined) {

            const perSiteStrictMode = (changes.perSiteStrictMode.newValue || {}) as SyncValueSchema[typeof PER_SITE_STRICT_MODE];
            setPerSiteStrictMode(perSiteStrictMode);

            // update DNR rules
            await perSiteStrictModeUpdated();

        } else if (changes.globalStrictMode?.newValue !== undefined) {

            const globalStrictMode = changes.globalStrictMode.newValue as SyncValueSchema[typeof GLOBAL_STRICT_MODE];
            setGlobalStrictMode(globalStrictMode);

            // update DNR rules
            await globalStrictModeUpdated();

        } else if (changes.proxyScheme || changes.proxyHost || changes.proxyPort) {
            // Reload all proxy settings if any changed
            await loadProxySettings();

            resetPolicyCookie();

            await updateProxySettingsInDnrRules();
        }
    }
})

// Changes icon depending on the extension is running or not
async function updateRunningIcon(extensionRunning: any) {
    if (extensionRunning) {
        await chrome.action.setIcon({path: "/images/scion-38.jpg"});
    } else {
        await chrome.action.setIcon({path: "/images/scion-38_disabled.jpg"});
    }
}

/*--- END storage ------------------------------------------------------------*/

/*--- tabs -------------------------------------------------------------------*/
initializeTabListeners()

/*--- requests ---------------------------------------------------------------*/
initializeRequestInterceptionListeners()
