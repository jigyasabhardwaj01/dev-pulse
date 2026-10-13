// next/font only works inside the Next.js compiler; tests get a stand-in with the same shape.
const font = (name: string) => () => ({ className: `font-${name}`, variable: `--font-${name}`, style: { fontFamily: name } });
export const Inter_Tight = font("sans");
export const Instrument_Serif = font("serif");
export const JetBrains_Mono = font("mono");
