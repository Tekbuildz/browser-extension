import {AutonomousSystem} from "./autonomous_system.js";

/**
 * Converts a string into its corresponding {@link AutonomousSystem} enum entry representation.
 * If {@link AutonomousSystem} does not contain a corresponding entry, {@link AutonomousSystem.AS_UNKNOWN} is returned instead.
 */
export function toAutonomousSystem(value: string) {
    return Object.values(AutonomousSystem).includes(value as AutonomousSystem)
        ? value as AutonomousSystem
        : AutonomousSystem.AS_UNKNOWN;
}
