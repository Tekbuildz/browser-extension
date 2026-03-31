import {CountryCode} from "./country_code.js";

export type GeoCoordinate =
    | { lat: number; lon: number; }
    | CountryCode.UNKNOWN
    | CountryCode.TO_BE_DETERMINED;

/**
 * Returns the {@link CountryCode} of the country in which the provided {@link coords} lie. If the
 * coordinates are {@link CountryCode.UNKNOWN} or {@link CountryCode.TO_BE_DETERMINED}, that same value
 * is returned.
 *
 * If the query fails to determine the country code, {@link CountryCode.UNKNOWN} is returned.
 */
export async function getCountryFromCoordinates(coords: GeoCoordinate): Promise<CountryCode> {
    if (coords === CountryCode.UNKNOWN) return CountryCode.UNKNOWN;
    if (coords === CountryCode.TO_BE_DETERMINED) return CountryCode.TO_BE_DETERMINED;

    try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lon}&format=json&zoom=3&addressdetails=1`;

        const response = await fetch(url);

        if (!response.ok) return CountryCode.UNKNOWN;

        const data = await response.json();

        const code = data?.address?.country_code?.toUpperCase();

        if (code && code in CountryCode) {
            return CountryCode[code as keyof typeof CountryCode];
        }

        return CountryCode.UNKNOWN;
    } catch {
        return CountryCode.UNKNOWN;
    }
}