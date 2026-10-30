/** Physical values are resolved from the engine mod, never inferred from its name. */
export const ELECTRIC_ACOUSTIC_PROFILE_FIELDS = [
  "radiusM", "blades", "chordM", "pitchM", "maxRpm", "referenceThrustN",
  "tonalGain", "broadbandGain", "mechanicalGain", "outputGain",
] as const;
export type ElectricAcousticProfile = Readonly<Record<typeof ELECTRIC_ACOUSTIC_PROFILE_FIELDS[number], number>>;

export function electricProfileValues(definition: { parameters: unknown } | unknown): number[] {
  const parameters = definition && typeof definition === "object" && "parameters" in definition
    ? (definition as { parameters: unknown }).parameters : definition;
  if (!parameters || typeof parameters !== "object") throw new Error("Missing procedural electric parameters");
  const profile = parameters as Record<string, unknown>;
  const values = ELECTRIC_ACOUSTIC_PROFILE_FIELDS.map(field => {
    const value = profile[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid procedural electric parameter ${field}`);
    return value;
  });
  const [radius, blades, chord, pitch, rpm, thrust, tonal, broadband, mechanical, output] = values;
  if (radius < 0.005 || radius > 5 || !Number.isInteger(blades) || blades < 1 || blades > 16
    || chord <= 0 || chord > radius || pitch < 0 || pitch > 10 * radius
    || rpm < 100 || rpm > 100_000 || thrust <= 0 || thrust > 100_000
    || [tonal, broadband, mechanical, output].some(value => value > 16)) {
    throw new Error("Invalid procedural electric reference range");
  }
  return values;
}

export function validateElectricProfile(parameters: unknown): ElectricAcousticProfile {
  const values = electricProfileValues(parameters);
  return Object.freeze(Object.fromEntries(ELECTRIC_ACOUSTIC_PROFILE_FIELDS.map((field, index) => [field, values[index]]))) as ElectricAcousticProfile;
}
