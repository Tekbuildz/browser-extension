import {PerSiteStrictMode} from "../shared/utilities.js";
import {PER_SITE_STRICT_MODE, saveSyncValue} from "../shared/storage.js";

// table
const sitePreferencesTable = document.getElementById("site-preferences-table") as HTMLTableElement;

// elements used when adding a new site preference
const addSitePreferenceDomainInput = document.getElementById("add-site-preference-domain-input") as HTMLInputElement;
const addSitePreferenceCheckbox = document.getElementById("add-site-preference-checkbox") as HTMLInputElement;
const addSitePreferenceButton = document.getElementById("add-site-preference-button") as HTMLButtonElement;

// section-specific initialization
document.addEventListener('DOMContentLoaded', async () => {
    addSitePreferenceButton.addEventListener("click", addSitePreferenceButtonOnClick);

    await updateSitePreferencesTable();
});

/**
 * Updates all values in the site-preferences table.
 */
async function updateSitePreferencesTable() {
    sitePreferencesTable.innerHTML = "";

    let siteIndex = 0;
    Object.keys(PerSiteStrictMode).forEach(site => {
        // adding the HTML
        const isStrict = PerSiteStrictMode[site];
        const elementId = getSitePreferenceId(siteIndex);
        sitePreferencesTable.innerHTML += `
        <tr>
            <td>${site}</td>
            <td>
                <div class="toggle-container flex flex-row items-center">
                    <input id="${elementId}" type="checkbox" class="strict-mode-toggle toggle toggle-success" ${isStrict ? "checked" : ""}/>
                    <label for="${elementId}" class="label-available ml-2 font-body cursor-pointer">When available</label>
                    <label for="${elementId}" class="label-strict ml-2 font-body cursor-pointer">Strict</label>
                </div>
            </td>
        </tr>`

        // registering the onclick-handler
        const checkbox = document.getElementById(elementId);
        if (checkbox === null) console.log("[updateSitePreferencesTable]: Failed to find element with index: ", siteIndex);
        checkbox?.addEventListener("click", async () => await sitePreferenceCheckboxOnClick(siteIndex));

        siteIndex++;
    });
}

/**
 * Event handler function that is invoked when the preference for a site changes.
 * Saves the new value.
 */
async function sitePreferenceCheckboxOnClick(siteIndex: number) {
    const elementId = getSitePreferenceId(siteIndex);
    const checkbox = document.getElementById(elementId) as HTMLInputElement | null;
    if (checkbox === null) {
        console.log("[sitePreferenceCheckboxOnClick]: Failed to find element with ID: ", elementId);
        return;
    }

    const site = Object.keys(PerSiteStrictMode)[siteIndex];
    PerSiteStrictMode[site] = checkbox.checked;
    await saveSyncValue(PER_SITE_STRICT_MODE, PerSiteStrictMode);
}

/**
 * Returns the ID of the site-preference input element with index {@link siteIndex}.
 */
function getSitePreferenceId(siteIndex: number) {
    return `table-domain-toggle-${siteIndex}`;
}

/**
 * Adds a new site-preference entry based on the values the user entered.
 *
 * Resets the values after saving them.
 */
async function addSitePreferenceButtonOnClick() {
    const domain = addSitePreferenceDomainInput.value;

    PerSiteStrictMode[domain] = addSitePreferenceCheckbox.checked;
    await saveSyncValue(PER_SITE_STRICT_MODE, PerSiteStrictMode);

    // reset the input values
    addSitePreferenceDomainInput.value = "";
    addSitePreferenceCheckbox.checked = false;

    await updateSitePreferencesTable();
}