import { isNative } from "../platform";

/**
 * Fingerprint / face sign-in for the Android app.
 * The username + password are kept in the Android Keystore with biometric access control
 * (BIOMETRY_CURRENT_SET): reading them needs a live biometric check bound to that read, and they are
 * invalidated if the phone's enrolled biometrics change. Nothing is stored on the web build.
 */
const SERVER = "hsn-autoreply-login";
const FLAG = "hsn.bioUser"; // which username has fingerprint sign-in on this device (no secret)

const plugin = async () => (await import("@capgo/capacitor-native-biometric")).NativeBiometric;
const am = async () => (await import("@capgo/capacitor-native-biometric")).AccessControl;

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
    return (await (await plugin()).isAvailable()).isAvailable;
  } catch {
    return false;
  }
}

export async function enableBio(username: string, password: string): Promise<void> {
  const NB = await plugin();
  const AccessControl = await am();
  await NB.setCredentials({ username, password, server: SERVER, accessControl: AccessControl.BIOMETRY_CURRENT_SET, title: "تفعيل الدخول بالبصمة", negativeButtonText: "إلغاء" });
  try {
    localStorage.setItem(FLAG, username);
  } catch {
    /* storage unavailable */
  }
}

/** Asks for the fingerprint and returns the saved sign-in, or null if cancelled / unavailable. */
export async function bioCredentials(): Promise<{ username: string; password: string } | null> {
  const NB = await plugin();
  const c = await NB.getSecureCredentials({ server: SERVER, title: "الدخول بالبصمة", subtitle: "HSN AutoReply", reason: "سجّل دخولك بالبصمة" });
  return c?.username && c?.password ? { username: c.username, password: c.password } : null;
}

export async function disableBio(): Promise<void> {
  try {
    localStorage.removeItem(FLAG);
  } catch {
    /* storage unavailable */
  }
  if (!isNative) return;
  await (await plugin()).deleteCredentials({ server: SERVER }).catch(() => undefined);
}
