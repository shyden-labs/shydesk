/**
 * Fixed Ed25519 key pairs for the DEV door's unit tests only (shyden-labs/shydesk#302). They sign
 * stand-in DEV passes and protect nothing: no unit test generates a key at run time
 * (shyden-labs/shydesk#209, tests/unit/no-runtime-keys.test.ts).
 */
interface PrivateJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d: string;
}

const MAIN: PrivateJwk = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'nJCp2Wfa5VLIcfxApyds86xAGPgz4JPuggxpbOGvhpk',
  d: 'lixFsspIUfiFLdVO9dopTHM0EXYjH0g46d594vW_QlI',
};
const OTHER: PrivateJwk = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'dSxrKK1XJ3M2s7wY_lrTVP954QsbEmcCU5-7D0Zm0K4',
  d: 'PiM75fRTB5vCJExtSsyzWxS1I5QN0dZTi-jjO4_xUW0',
};

/** The signing half and the public `x` a door lists, for one fixed pair. */
export interface PassKeyPair {
  privateKey: CryptoKey;
  x: string;
}

async function pair(jwk: PrivateJwk): Promise<PassKeyPair> {
  const privateKey = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, 'Ed25519', true, ['sign']);
  return { privateKey, x: jwk.x };
}

/** The pair a test's door trusts. */
export const passKeys = (): Promise<PassKeyPair> => pair(MAIN);
/** A pair no door lists, for a pass signed by the wrong key. */
export const otherPassKeys = (): Promise<PassKeyPair> => pair(OTHER);
