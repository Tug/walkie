import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
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
import { McpClient } from "./src/mcp";
import { startVoiceSession, type VoiceSession } from "./src/realtime";

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
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    AsyncStorage.getMany(["serverUrl", "fleetToken"]).then((vals) => {
      if (vals.serverUrl) setServerUrl(vals.serverUrl);
      if (vals.fleetToken) setToken(vals.fleetToken);
    });
  }, []);

  async function connect() {
    const base = serverUrl.trim().replace(/\/$/, "");
    if (!base || !token.trim()) {
      setStatus("Server URL and fleet token are required");
      return;
    }
    await AsyncStorage.setMany({ serverUrl: base, fleetToken: token.trim() });
    setPhase("connecting");
    try {
      setStatus("Loading fleet tools…");
      const mcp = new McpClient(base, token.trim());
      const tools = await mcp.init();
      session.current = await startVoiceSession(base, token.trim(), mcp, tools, {
        onStatus: setStatus,
        onTranscriptDelta: (d) => {
          setTalking(true);
          setTranscript((t) => t + d);
        },
        onTurnDone: () => {
          setTalking(false);
          setTranscript((t) => `${t}\n\n`);
        },
        onApproval: (name, args) => new Promise((resolve) => setApproval({ name, args, resolve })),
      });
      setPhase("live");
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
      setPhase("setup");
    }
  }

  function hangup() {
    session.current?.hangup();
    session.current = null;
    setPhase("setup");
    setTalking(false);
    setMuted(false);
    setStatus("Disconnected.");
  }

  function toggleMute() {
    const next = !muted;
    session.current?.mute(next);
    setMuted(next);
  }

  return (
    <View style={styles.body}>
      <StatusBar style="light" />
      <Text style={styles.title}>🎙️ walkie</Text>

      {phase !== "live" && (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Server URL (https://walkie.example.com)"
            placeholderTextColor="#5c6b78"
            autoCapitalize="none"
            autoCorrect={false}
            value={serverUrl}
            onChangeText={setServerUrl}
          />
          <TextInput
            style={styles.input}
            placeholder="Fleet token"
            placeholderTextColor="#5c6b78"
            secureTextEntry
            value={token}
            onChangeText={setToken}
          />
          <Pressable
            style={[styles.button, styles.primary, phase === "connecting" && styles.disabled]}
            disabled={phase === "connecting"}
            onPress={connect}
          >
            <Text style={styles.buttonText}>{phase === "connecting" ? "Connecting…" : "Connect"}</Text>
          </Pressable>
        </KeyboardAvoidingView>
      )}

      {phase === "live" && (
        <View style={styles.session}>
          <View style={[styles.orb, talking ? styles.orbTalking : styles.orbLive]} />
          <View style={styles.row}>
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
        </View>
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
  transcriptText: { color: "#c9d4dc", fontSize: 15, lineHeight: 22 },
  status: { color: "#9fb0bd", fontSize: 13, paddingVertical: 16, minHeight: 40 },
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
