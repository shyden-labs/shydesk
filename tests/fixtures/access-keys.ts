/**
 * Fixed RS256 key pairs for unit tests only (shyden-labs/shydesk#209). They sign
 * stand-in Cloudflare Access tokens and protect nothing: generating keys at run
 * time took a random, sometimes over 1 s, share of a test's setup.
 */
import { importJWK, type JWK } from 'jose';

type PrivateJwk = JWK & { kty: 'RSA'; n: string; e: string; d: string };

const SIGNER: PrivateJwk = {
  kty: 'RSA',
  n: 'uRagd0XhxnuknHXT0XPoyes2-koa3OPk5zxoPkvV_p7_w49hrZGuQYVMpLTLK4qqRrjNk2xXLkMcZ73tHvxc30yPyDO_OsoYUufEnDg2BYwNcS70YPuMzIaPOMzzuvZYxLyaj-eqo25nBFxIPmU6KOiUJQww40w5z8TbPV8wpqAkRjB7xmRE4OA-Q-b90RX83auCTvstUtbZvv4t2FwAzRPi_EnCqxIsFVq49CllM5sLA0qcxOgS1tGY7MbfYT3F0BeDqfwUa0NPi0JQnmhmcYtQVECBbOm4gRxJNoaj4xePiorUif2HlxYuYgpdcVnuQA5Xv3vb5PvjU75v0PRujw',
  e: 'AQAB',
  d: 'BFLl_sNQKe3bg5gxEZSOnKD1ENXIWN6uC0Ta_pGQ9zjJqszfsElV88vkZXifwm2j2rEYhFgklT0WHcpPDslAdir4tOmYjwwHk3A8pJWflXOXIMzDArz9pg2CrQYEr5pvqnDpf3EfCGBc4boyKdr9h9UfGNp3DehK9XKY2I8vuMS8xj_S_OLu0nkD9n64-e9vk739Fft1JEfytU8uGr9OpXzk_T8N-sUU3hjT6XmIikLtUr_RRDSjhYe0WBRm3yJ0XHl7J1-COkCZME1D3fZFNDK-t25KR7tcMFg3k41P2GK8S0Ah6AMkw7eYLdiZz8baA3w8xTmVjLjx5vUiKpcQQQ',
  p: '4x2nVmW2iTx_S-sZw3MeswIRIGjz_vHwoENV1d9YoT4kfr3AuE_EBNjZx9q-EY0fCC1YJwVbEu_ILPEqnQtb1f9jFZbd6GhG352GxgYQZOUVu20v6PPPRCJWp74PT5FFjfW9n09XK-1QkQ2CVR355G4tTwphN5eTUV0SO_vnIKE',
  q: '0KCpCyyFpqxDx3ScfaSglmki2vbTUzVo0W9Nepj3Gd2Z3fNIdZF4r3vCp3nTVFp-FklMlYO0gcwT-iX1DmkOqpoNnZZEh67odyKpnx_C_ksWnr0YAE6xH_pgpgYczUOConDHqesMj7BmfSbrab8dhgBSXDxRhlIB9yR7hfqi0S8',
  dp: 'JMPbH9hNST_6115SiFotYQr3nMiAnwepTTg5P-rs3QVDQSUUeoGnGKXF811MoWi32koE2CQ8zv7z55qOrGd3UVgLQSZv-7xNpMtKUuoOY1bWQsX1GH_HUJ9CadsRfW7l1IowTQa59Mlw3lpSe9bjagAP45ipjidCWMx5NC6eBqE',
  dq: 'EYVsrQOQNe9Bwf6JJgQteHRb-QfBt7tEklJGr4UpO4Lg6UMFUtpkyFgcgPQ6S1tOO5DsXaIyBrSc-OU3L36jPLCzdAiquLp3y4mdtT91oOWtgKdg3KW_OnBMraTVxmdlET9nhV24MFkgQmKCYt8qG5brU9O9BQreH2Nw_E-QXQE',
  qi: 'py17wWznpk6PulKtZ4BC6brMhRLcYbN9OPKrj9OT59TAa0vtq_hCbBywidRbCopWL-DfFC-ITpguKj2Hip0qc-d9_T4Hw-zImrBwWlUuYESDsjSgW3y1VepG04il9p8ST4e2OaCq65S3_i0ZInxlO2iFInwHaOw7rdKwxDjBq6s',
};

const OTHER: PrivateJwk = {
  kty: 'RSA',
  n: 'wJEPQ0cPDNA-rkCDS3C_UIv4QkfcSfmnjak76a5UCQHHnNdcdYThy4SD5dKa8Qacq1orjBbyz4IVCfRU2EnqXNH0l-joBAs6FZ4W6WUOMCmEgJC0IeDN38m7-lh5u6H4tsNBUSmpt5kvXPIh7xKZN14-CBWB34dDIJ99mf0m0dAvIDRF0f58bTRmbc_surylyIijywN0mt_M8EJ4WMtnXAZdnb0ZAFHK3_CP9AhwUQAWeWWrW58DzyKi1aPcmrGbikj9h5aTIUfEFS4NW628qWaFItlsQOJVVHyf0kRFDZDxbIEUqoxBrVyX2lQrd_1S6d7hZKb0iaoJsJ3r33zWgQ',
  e: 'AQAB',
  d: 'PaCvD8r4CBPFW6MN4eDteWuyQhQZbhtWAkI9CGZgQpmtNoa98mZalPWN-MlUCPsivLwY37agcsSg0xS86pONS7Nt4ggJ6PFm33A-yOcsiUFgRH0LCSSW_p3jaRVTsDcAEA2hI8Z_qGCABfD_5zE-k7e3hoLLk6wIUbJ5UgTwnYjCvNEVbZsViAJb7dLJmO6377IHx5IHKcx_W152AbgdWm4TiwXHY275L_WNNe_sLDAMpqab9caLARh-VlEyv2KWprw8gpdvLxdyXw2SdMC2q1hwxqOa2hbQudW9VTlVz_fTigOLFscNH2Tbt_7SoU06SRDFQ6MM7tlbXLWakD_JOQ',
  p: '5RbLe7k22BBoaQTUWmHcHUfDbeQMadV8eIh3hcB0lanx8E-6gVPLOR3R0DOE3KtPXODZGUs5C8eIxLmked4PJPDtvcytrMIVe5vQF29t39XFuVmGMTt8Q6yEtFv3zXu3XYtQvKzsDhy49XPMc_hhKYLP6cFaxpeITHL7NJDHiNc',
  q: '1y_07lbHKhLVElQHd4wQPxfy_OgwG0AuLCctuQ5EnqUsWaorq-Vf97yeWzunjrb-wdzcUH2uVqbdnZSq7zdPEwJ8Cthsbhdxu_tO9ClJnBZnTmW_ThcHEzwjer5zMeii1FO8vktGqZZsxNWR6bwzRZ5JvtP-eMRuN4P6EW9weGc',
  dp: 'MrpJdKweqNl5RUf8fccNpq4taDgHR6guV8JgNQ3YwwtOt5fwBJM5fPxNaXz-_p4whLCFYkR17VXRwz4YXaP-Vn_DJTQdgRO5DhYCji3udpIvpktcm6pAafvZptZ2mNm8UMp4pk7kNnvFuRRbQZLOcRK2V1ypbTBAzizn00v74yE',
  dq: 'B8t-7dtK36VK_pz4oEX8mKx_atXmWDZc9dB9gYSYy75j-uOFLXbjoQ--FMP2b98FH3Smrmu_Evh8cqbeAkhYnvGqGKJ6WwqSXiLeW03bksHlABwDcAq5gOLeziVz-szYiSR3Y9VKO_5s9jxeSr88hDsVpMn9H9bNv0kSl-sXgeU',
  qi: 'AdApmJ1bJVHo0s_6Fxa4fbY_SkiVFI4C0O1X3IaOB1TANC-v9HFvUEJbB8GhhDuIR7eFdlEgRLVKXda1iuTKNqWz21eaiy8Wx45BVx55lFG6G0uRfDi49xf8nkG9XneVqjOT0_uYWhoXyiJ0O8wUjEL3eMAX7bGkHAbrY98WMzA',
};

/** The public half of the signing key, for a local key set; callers add `kid` and `alg`. */
export const PUBLIC_JWK: JWK = { kty: SIGNER.kty, n: SIGNER.n, e: SIGNER.e };

/** The key that signs tokens the stand-in key set accepts. */
export const signingKey = () => importJWK(SIGNER, 'RS256');

/** A second key, absent from the key set, for tokens that must be refused. */
export const otherSigningKey = () => importJWK(OTHER, 'RS256');
