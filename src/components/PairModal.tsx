import { VFC, useState } from "react";
import { ModalRoot, DialogButton } from "decky-frontend-lib";
import { call } from "../util";
import { TextRow } from "./inputs";

// Pair a Moonlight client with Docky's Sunshine. If no Sunshine login is stored
// yet, first set one (Docky takes ownership of the credentials); then submit the
// PIN Moonlight shows.
export const PairModal: VFC<{
  closeModal?: () => void;
  credsStored: boolean;
  onState: (st: any) => void;
}> = ({ closeModal, credsStored, onState }) => {
  const [mode, setMode] = useState<"login" | "pair">(credsStored ? "pair" : "login");
  const [user, setUser] = useState<string>("docky");
  const [pass, setPass] = useState<string>("");
  const [pin, setPin] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

  function saveLogin() {
    setBusy(true);
    setMsg("Setting login…");
    call<any>("set_sunshine_login", { username: user, password: pass })
      .then((r) => {
        setBusy(false);
        setMsg((r && r.message) || (r && r.ok ? "Login set" : "Failed"));
        if (r && r.ok) {
          if (r.state) onState(r.state);
          setMode("pair");
        }
      })
      .catch((e) => {
        setBusy(false);
        setMsg("Error: " + e);
      });
  }

  function doPair() {
    setBusy(true);
    setMsg("Pairing…");
    call<any>("sunshine_pair", { pin, name })
      .then((r) => {
        setBusy(false);
        setMsg((r && r.message) || (r && r.ok ? "Paired" : "Failed"));
        if (r && r.ok) setPin("");
      })
      .catch((e) => {
        setBusy(false);
        setMsg("Error: " + e);
      });
  }

  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <div style={{ fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" }}>Pair a device</div>

      {mode === "login" ? (
        <div>
          <div style={{ fontSize: "0.8em", opacity: 0.7, marginBottom: "4px" }}>
            Set a Sunshine login (used to authorize pairing). This resets Sunshine's
            username/password — existing paired devices are kept.
          </div>
          <TextRow label="Username" value={user} onChange={setUser} />
          <TextRow label="Password" value={pass} onChange={setPass} />
          <DialogButton disabled={busy || !user.trim() || !pass} onClick={saveLogin}>
            Save login
          </DialogButton>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: "0.8em", opacity: 0.7, marginBottom: "4px" }}>
            In Moonlight, select this Deck — it shows a PIN. Enter that PIN here.
          </div>
          <TextRow label="PIN" value={pin} onChange={setPin} />
          <TextRow label="Device name (optional)" value={name} onChange={setName} />
          <div style={{ display: "flex", gap: "8px" }}>
            <DialogButton disabled={busy || !pin.trim()} onClick={doPair}>
              Pair
            </DialogButton>
            <DialogButton disabled={busy} onClick={() => setMode("login")}>
              Change login
            </DialogButton>
          </div>
        </div>
      )}

      {msg ? <div style={{ fontSize: "0.8em", opacity: 0.85, marginTop: "8px" }}>{msg}</div> : null}
      <div style={{ marginTop: "10px" }}>
        <DialogButton disabled={busy} onClick={() => closeModal && closeModal()}>
          Close
        </DialogButton>
      </div>
    </ModalRoot>
  );
};
