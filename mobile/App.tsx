import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { setSpeaker, startAudio, stopAudio } from "./src/audio";
import { McpClient } from "./src/mcp";
import { startVoiceSession, type VoiceSession } from "./src/realtime";
import { getMicStream } from "./src/rtc";

// Default server URL baked in via app config (extra.walkieServerUrl), e.g. the Tailscale
// Funnel hostname, so the app connects over cellular with no typing.
const DEFAULT_SERVER_URL = (Constants.expoConfig?.extra as { walkieServerUrl?: string } | undefined)?.walkieServerUrl ?? "";

type Phase = "setup" | "connecting" | "live";

interface ApprovalRequest {
  name: string;
  args: object;
  resolve: (ok: boolean) => void;
}

export default function App() {
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [status, setStatus] = useState("");
  const [transcript, setTranscript] = useState("");
  const [talking, setTalking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeakerState] = useState(true);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [draft, setDraft] = useState("");
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const scroll = useRef<ScrollView>(null);
  // wantLive: the user intends an active session (Connect pressed, not hung up). appActive: current
  // foreground state. busy: a connect is in flight (guards against overlapping reconnects). connectRef
  // holds the latest connect() so the AppState listener never calls a stale closure.
  const wantLive = useRef(false);
  const appActive = useRef(true);
  const busy = useRef(false);
  const connectRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    (async () => {
      const vals = await AsyncStorage.getMany(["fleetToken"]);
      if (vals.fleetToken) setToken(vals.fleetToken);
      // Server URL is authoritative from config, not persisted: on web the app is served by
      // the walkie server (its own origin); on native the baked default (extra.walkieServerUrl).
      // This avoids a stale saved URL (e.g. an old LAN IP) shadowing the current default.
      const origin = Platform.OS === "web" ? ((globalThis as any).location?.origin ?? "") : "";
      const base = origin || DEFAULT_SERVER_URL;
      if (base) setServerUrl(base);
      // Detect an existing cookie session (AUTH_MODE=google) against the resolved base.
      const probe = origin || DEFAULT_SERVER_URL;
      if (probe) {
        try {
          const me = await fetch(`${probe}/auth/me`);
          if (me.ok) setSessionEmail(((await me.json()) as { email?: string }).email ?? null);
        } catch {
          // no session: manual token entry
        }
      }
    })();
  }, []);

  // One-tap Google sign-in: open the server's /auth/login?client=app in the system browser,
  // which returns to walkie://auth?token=<7-day session> once the @juisci.com account is picked.
  async function signInWithGoogle() {
    const base = serverUrl.trim().replace(/\/$/, "");
    if (!base) return setStatus("No server URL configured");
    // On web the app is same-origin with the server: a full-page redirect sets the cookie.
    if (Platform.OS === "web") {
      (globalThis as any).location.href = `${base}/auth/login`;
      return;
    }
    setStatus("Opening sign-in…");
    try {
      const result = await WebBrowser.openAuthSessionAsync(`${base}/auth/login?client=app`, "walkie://auth");
      if (result.type !== "success" || !result.url) return setStatus("Sign-in cancelled");
      const t = new URL(result.url).searchParams.get("token");
      if (!t) return setStatus("Sign-in returned no token");
      await AsyncStorage.setMany({ fleetToken: t });
      setToken(t);
      setStatus("Signed in. Tap Connect.");
    } catch (err: any) {
      setStatus(`Sign-in failed: ${err.message}`);
    }
  }

  async function connect() {
    const base = serverUrl.trim().replace(/\/$/, "");
    const webCookie = Platform.OS === "web" && !!sessionEmail;
    if (!base || (!token.trim() && !webCookie)) {
      setStatus("Sign in first");
      return;
    }
    if (busy.current) return; // a connect/reconnect is already in flight
    busy.current = true;
    wantLive.current = true;
    // Drop any stale session (e.g. a dead one we're replacing on reconnect) before opening a new one.
    session.current?.hangup();
    session.current = null;
    await AsyncStorage.setMany({ fleetToken: token.trim() });
    setPhase("connecting");
    let mic: unknown;
    try {
      // Mic first, inside the tap gesture: iOS Safari refuses getUserMedia once
      // network awaits have consumed the user-activation window.
      setStatus("Requesting microphone…");
      mic = await getMicStream();
      setStatus("Loading fleet tools…");
      const mcp = new McpClient(base, token.trim());
      const tools = await mcp.init();
      session.current = await startVoiceSession(base, token.trim(), mcp, tools, {
        onStatus: setStatus,
        onTranscriptDelta: (d) => {
          setTalking(true);
          setTranscript((t) => t + d);
        },
        onUserSpeech: (text) => setTranscript((t) => `${t}You: ${text}\n\n`),
        onTurnDone: () => {
          setTalking(false);
          setTranscript((t) => `${t}\n\n`);
        },
        onApproval: (name, args) => new Promise((resolve) => setApproval({ name, args, resolve })),
        onClosed: handleClosed,
      }, mic);
      setPhase("live");
      // Route to loudspeaker (WebRTC forces the earpiece on connect); re-assert once more
      // ~1.5s later to win the known race where WebRTC resets the audio session category.
      startAudio();
      setSpeaker(speaker);
      setTimeout(() => setSpeaker(speaker), 1500);
    } catch (err: any) {
      (mic as { getTracks?: () => { stop: () => void }[] })?.getTracks?.().forEach((t) => t.stop());
      setStatus(`Error: ${err.message}`);
      setPhase("setup");
    } finally {
      busy.current = false;
    }
  }
  connectRef.current = connect;

  // Called when the WebRTC connection drops (typically iOS suspending the backgrounded app).
  // If the user still wants a live session, reconnect right away when in the foreground; when
  // backgrounded, defer to the AppState listener, which reconnects on the next resume.
  function handleClosed(reason: string) {
    session.current = null;
    if (!wantLive.current) return;
    if (appActive.current) {
      setStatus("Connection dropped. Reconnecting…");
      void connectRef.current();
    } else {
      setPhase("connecting");
      setStatus("Connection dropped while in background. Reopen to reconnect.");
    }
  }

  // Reopening the app after iOS suspended it leaves a dead connection that still shows "Live".
  // On every return to the foreground, if the session isn't actually alive, reconnect a fresh one.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      appActive.current = next === "active";
      if (next === "active" && wantLive.current && !busy.current) {
        if (!(session.current?.isAlive?.() ?? false)) {
          setStatus("Reconnecting…");
          void connectRef.current();
        }
      }
    });
    return () => sub.remove();
  }, []);

  function hangup() {
    wantLive.current = false;
    session.current?.hangup();
    session.current = null;
    stopAudio();
    setPhase("setup");
    setTalking(false);
    setMuted(false);
    setStatus("Disconnected.");
  }

  function toggleSpeaker() {
    const next = !speaker;
    setSpeakerState(next);
    setSpeaker(next);
  }

  function toggleMute() {
    const next = !muted;
    session.current?.mute(next);
    setMuted(next);
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text || !session.current) return;
    session.current.sendText(text);
    setTranscript((t) => `${t}You: ${text}\n\n`);
    setDraft("");
  }

  async function attachImage() {
    if (!session.current) return;
    try {
      // Dynamic import: the native module ships with the NEXT dev build; on a build
      // that predates it we degrade to a status message instead of crashing.
      const picker = await import("expo-image-picker");
      const perm = await picker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return setStatus("Photo library permission denied");
      const res = await picker.launchImageLibraryAsync({ base64: true, quality: 0.2 });
      const asset = res.assets?.[0];
      if (!asset?.base64) return;
      const dataUrl = `data:${asset.mimeType ?? "image/jpeg"};base64,${asset.base64}`;
      if (dataUrl.length > 200_000) return setStatus("Image too large for the session channel; pick a smaller one");
      session.current.sendImage(dataUrl);
      setTranscript((t) => `${t}You: [image]\n\n`);
    } catch {
      setStatus("Image attach needs the latest dev build (expo-image-picker)");
    }
  }

  return (
    <View style={styles.body}>
      <StatusBar style="light" />
      <Text style={styles.title}>🎙️ walkie</Text>

      {phase !== "live" && (
        <View style={styles.form}>
          <Text style={styles.serverNote}>{serverUrl || "no server configured"}</Text>
          {token || (Platform.OS === "web" && sessionEmail) ? (
            <>
              <Text style={styles.signedIn}>{sessionEmail ? `Signed in${sessionEmail.includes("@") ? ` as ${sessionEmail}` : ""}` : "Token ready"}</Text>
              <Pressable
                style={[styles.button, styles.primary, phase === "connecting" && styles.disabled]}
                disabled={phase === "connecting"}
                onPress={connect}
              >
                <Text style={styles.buttonText}>{phase === "connecting" ? "Connecting…" : "Connect"}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable style={[styles.button, styles.primary]} onPress={signInWithGoogle}>
              <Text style={styles.buttonText}>Sign in with Google</Text>
            </Pressable>
          )}
        </View>
      )}

      {phase === "live" && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.session}
          keyboardVerticalOffset={40}
        >
          <View style={[styles.orb, talking ? styles.orbTalking : styles.orbLive]} />
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.ghost]} onPress={toggleSpeaker}>
              <Text style={styles.buttonText}>{speaker ? "🔊 Speaker" : "🎧 AirPods/Ear"}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.ghost]} onPress={toggleMute}>
              <Text style={styles.buttonText}>{muted ? "Unmute" : "Mute"}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.danger]} onPress={hangup}>
              <Text style={styles.buttonText}>Hang up</Text>
            </Pressable>
          </View>
          <ScrollView
            ref={scroll}
            style={styles.transcript}
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
          >
            <Text style={styles.transcriptText} selectable>
              {transcript}
            </Text>
          </ScrollView>
          <View style={styles.composer}>
            <Pressable style={[styles.button, styles.ghost, styles.attach]} onPress={attachImage}>
              <Text style={styles.buttonText}>📎</Text>
            </Pressable>
            <TextInput
              style={[styles.input, styles.composerInput]}
              placeholder="Type instead (URLs, names, code…)"
              placeholderTextColor="#5c6b78"
              autoCapitalize="none"
              autoCorrect={false}
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={sendDraft}
              returnKeyType="send"
            />
            <Pressable style={[styles.button, styles.primary]} onPress={sendDraft}>
              <Text style={styles.buttonText}>Send</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}

      <Text style={styles.status}>{status}</Text>

      <Modal visible={approval !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Allow {approval?.name}?</Text>
            <Text style={styles.cardArgs}>{JSON.stringify(approval?.args, null, 2)}</Text>
            <View style={styles.row}>
              <Pressable
                style={[styles.button, styles.ghost]}
                onPress={() => {
                  approval?.resolve(false);
                  setApproval(null);
                }}
              >
                <Text style={styles.buttonText}>Deny</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.primary]}
                onPress={() => {
                  approval?.resolve(true);
                  setApproval(null);
                }}
              >
                <Text style={styles.buttonText}>Approve</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, backgroundColor: "#101418", alignItems: "center", paddingTop: 80, paddingHorizontal: 24 },
  title: { color: "#e8ecef", fontSize: 22, letterSpacing: 3, marginBottom: 32 },
  form: { width: "100%", maxWidth: 420 },
  input: {
    backgroundColor: "#181f26",
    borderColor: "#2c3540",
    borderWidth: 1,
    borderRadius: 10,
    color: "#e8ecef",
    fontSize: 16,
    padding: 14,
    marginBottom: 12,
  },
  button: { paddingVertical: 14, paddingHorizontal: 22, borderRadius: 10, alignItems: "center" },
  primary: { backgroundColor: "#3ba55c" },
  danger: { backgroundColor: "#b3403f" },
  ghost: { backgroundColor: "#232b33" },
  disabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  session: { flex: 1, width: "100%", maxWidth: 420, alignItems: "center" },
  orb: { width: 110, height: 110, borderRadius: 55, marginVertical: 24 },
  orbLive: { backgroundColor: "#3ba55c" },
  orbTalking: { backgroundColor: "#4f8fd3", transform: [{ scale: 1.1 }] },
  row: { flexDirection: "row", gap: 12, justifyContent: "center", marginBottom: 16 },
  transcript: { flex: 1, width: "100%" },
  composer: { flexDirection: "row", gap: 8, width: "100%", alignItems: "center", paddingBottom: 8 },
  composerInput: { flex: 1, marginBottom: 0 },
  attach: { paddingHorizontal: 14 },
  transcriptText: { color: "#c9d4dc", fontSize: 15, lineHeight: 22 },
  status: { color: "#9fb0bd", fontSize: 13, paddingVertical: 16, minHeight: 40 },
  signedIn: { color: "#3ba55c", fontSize: 14, marginBottom: 12, textAlign: "center" },
  serverNote: { color: "#5c6b78", fontSize: 12, marginBottom: 20, textAlign: "center" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center" },
  card: { backgroundColor: "#181f26", borderRadius: 14, padding: 22, width: "88%", maxWidth: 420 },
  cardTitle: { color: "#e8ecef", fontSize: 17, fontWeight: "700", marginBottom: 10 },
  cardArgs: {
    color: "#c9d4dc",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    backgroundColor: "#10161c",
    borderRadius: 8,
    padding: 10,
    marginBottom: 14,
  },
});
