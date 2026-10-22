import { isNative } from "../platform";

/**
 * Fingerprint / face sign-in for the Android app.
 * The username + password are kept in the Android Keystore with biometric access control
 * (BIOMETRY_CURRENT_SET): reading them needs a live biometric check bound to that read, and they are
 * invalidated if the phone's enrolled biometrics change. Nothing is stored on the web build.
 *
 * Note: never return a Capacitor plugin object from an async function — the Promise machinery probes it
 * for `.then`, the plugin proxy turns that into a native call that never answers, and the await hangs.
 * Always destructure it from the module and call its methods directly (as below).
 */
const SERVER = "hsn-autoreply-login";
const FLAG = "hsn.bioUser"; // which username has fingerprint sign-in on this device (no secret)

const mod = () => import("@capgo/capacitor-native-biometric");

/** Rejects if a native call does not answer in time (a stuck plugin must never block the app). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

export function bioUser(): string | null {
  if (!isNative) return null;
  try {
    return localStorage.getItem(FLAG);
  } catch {
    return null;
  }
}

export async function bioAvailable(): Promise<boolean> {
  if (!isNative) return false;
  try {
    return await withTimeout(
      (async () => {
        const { NativeBiometric } = await mod();
        const r = await NativeBiometric.isAvailable();
        return !!r.isAvailable;
      })(),
      4000,
    );
  } catch {
    return false;
  }
}

export async function enableBio(username: string, password: string): Promise<void> {
  const { NativeBiometric, AccessControl } = await mod();
  await NativeBiometric.setCredentials({ username, password, server: SERVER, accessControl: AccessControl.BIOMETRY_CURRENT_SET, title: "تفعيل الدخول بالبصمة", negativeButtonText: "إلغاء" });
  try {
    localStorage.setItem(FLAG, username);
  } catch {
    /* storage unavailable */
  }
}

/** Asks for the fingerprint and returns the saved sign-in, or null if cancelled / unavailable. */
export async function bioCredentials(): Promise<{ username: string; password: string } | null> {
  const { NativeBiometric } = await mod();
  const c = await NativeBiometric.getSecureCredentials({ server: SERVER, title: "الدخول بالبصمة", subtitle: "شيّك", reason: "سجّل دخولك بالبصمة" });
  return c?.username && c?.password ? { username: c.username, password: c.password } : null;
}

export async function disableBio(): Promise<void> {
  try {
    localStorage.removeItem(FLAG);
  } catch {
    /* storage unavailable */
  }
  if (!isNative) return;
  try {
    const { NativeBiometric } = await mod();
    await withTimeout(NativeBiometric.deleteCredentials({ server: SERVER }), 4000);
  } catch {
    /* nothing saved */
  }
}

/**
 * Right after a password sign-in the app may offer fingerprint sign-in. Checked in the background
 * (never delays signing in); the password stays in memory only until the user answers.
 */
let pending: { username: string; password: string } | null = null;
export function offerBioLater(username: string, password: string) {
  if (!isNative || bioUser()) return;
  void bioAvailable().then((ok) => {
    if (!ok) return;
    pending = { username, password };
    window.dispatchEvent(new Event("hsn:bio-offer"));
  });
}
export function takeBioOffer(): { username: string; password: string } | null {
  const p = pending;
  pending = null;
  return p;
}
