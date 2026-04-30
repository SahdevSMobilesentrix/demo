// Angel One SmartAPI — login by password + TOTP.
// Docs: https://smartapi.angelbroking.com/docs/User
//
// Required inputs:
//   apiKey      — your SmartAPI app's "API Key" (a.k.a. private key)
//   clientCode  — Angel One client/login id (e.g. "A1234")
//   pin         — your trading/login PIN (numeric)
//   totp        — 6-digit TOTP from your authenticator app

import axios from "axios";

const LOGIN_URL =
  "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword";

export async function loginAngelOne({ apiKey, clientCode, pin, totp }) {
  if (!apiKey || !clientCode || !pin || !totp) {
    throw new Error("apiKey, clientCode, pin and totp are all required");
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
  };

  const body = { clientcode: clientCode, password: pin, totp };

  const { data } = await axios.post(LOGIN_URL, body, {
    headers,
    timeout: 15000,
    validateStatus: () => true,
  });

  if (!data || data.status === false || !data.data) {
    const msg = data?.message || data?.errorcode || "login failed";
    const err = new Error(msg);
    err.raw = data;
    throw err;
  }

  return {
    jwtToken: data.data.jwtToken,
    refreshToken: data.data.refreshToken,
    feedToken: data.data.feedToken,
    raw: data,
  };
}
