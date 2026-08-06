import { VFC, useState, useEffect, useRef } from "react";
import { ModalRoot, DialogButton, showModal, ConfirmModal } from "decky-frontend-lib";
import { call, errText } from "../util";
import { TextRow } from "./inputs";

interface Client {
  uuid: string;
  name?: string;
  enabled?: boolean;
}

// Backend responses are loosely shaped; keep the fields we actually read typed.
interface CallResult {
  ok?: boolean;
  message?: string;
  state?: any;
  clients?: Client[];
}

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
  const [clients, setClients] = useState<Client[]>([]);

  // Guard against state updates after the modal is dismissed mid-request.
  const mounted = useRef(true);
  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  // Terminal results for pair/login are announced in an OK dialog rather than as
  // inline text. Those two flows are the ones driven from the on-screen
  // keyboard, and inline text is a bad channel for them twice over: the keyboard
  // covers the bottom of the screen, and text appearing/disappearing above the
  // fields reflows the modal -- which reads as the page "shuffling" rather than
  // as an answer to what you just did. A dialog can't be missed and can't move
  // anything. Raw showModal (not index.tsx's poll-pausing openModal) is correct
  // here: this modal is already open through that wrapper, so the background
  // poll is paused for our whole lifetime, alert included.
  function showResult(message: string) {
    showModal(
      <ConfirmModal
        bAlertDialog
        strTitle="Pair a device"
        strDescription={message}
        strOKButtonText="OK"
      />,
    );
  }

  // Centralized, unmount-safe completion for the async handlers below.
  // `alert` routes the result to the dialog; without it the message stays inline
  // (used by the client-list mutations, where the list visibly changing is
  // already the feedback and a dialog per row would be noise).
  function finish(message: string, alert = false) {
    if (!mounted.current) return;
    setBusy(false);
    setMsg("");
    if (alert) showResult(message);
    else setMsg(message);
  }

  // Steam's on-screen keyboard swallows the FIRST activation of a button behind
  // it: the press reaches the button as `pointerdown`, but the `click` that
  // should follow is retargeted to the element underneath (the keyboard is
  // dismissing), so React's onClick never runs. The press looks like a total
  // no-op -- no message, no request, no log line -- and the user has to press
  // twice. Confirmed on-device by recording events during a failing press:
  //   pointerdown -> BUTTON "Pair"   |  click -> DIV      (swallowed)
  //   pointerdown -> BUTTON "Pair"   |  click -> BUTTON   (works)
  // Binding pointerdown IN ADDITION to click makes the first press count. The
  // timestamp guard collapses the pointerdown+click pair of a normal press into
  // a single activation, so nothing double-fires -- which matters here because
  // a doubled pair/login submit would fire two Sunshine API calls.
  const lastFire = useRef(0);
  function activate(fn: () => void) {
    return () => {
      const now = Date.now();
      if (now - lastFire.current < 500) return;
      lastFire.current = now;
      fn();
    };
  }

  function refreshClients(surfaceError = false) {
    call<CallResult>("sunshine_clients")
      .then((r) => {
        if (!mounted.current) return;
        if (r && r.clients) setClients(r.clients);
      })
      .catch((e) => {
        // Post-mutation refreshes stay quiet so they don't clobber the success
        // message; the initial load surfaces failure so an errored fetch isn't
        // silently rendered as "no paired devices".
        if (surfaceError && mounted.current) setMsg("Couldn't load devices: " + errText(e));
      });
  }

  useEffect(() => {
    if (credsStored) refreshClients(true);
    // credsStored is stable for the modal's lifetime; intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchMode(next: "login" | "pair") {
    setMode(next);
    setMsg("");
  }

  function unpairOne(uuid: string) {
    setBusy(true);
    setMsg("Unpairing…");
    call<CallResult>("sunshine_unpair", { uuid })
      .then((r) => {
        finish((r && r.message) || "done");
        refreshClients();
      })
      .catch((e) => finish("Error: " + errText(e)));
  }

  function setEnabled(uuid: string, enabled: boolean) {
    setBusy(true);
    setMsg(enabled ? "Enabling…" : "Disabling…");
    call<CallResult>("sunshine_set_client_enabled", { uuid, enabled })
      .then((r) => {
        finish((r && r.message) || "done");
        refreshClients();
      })
      .catch((e) => finish("Error: " + errText(e)));
  }

  function unpairAll() {
    setBusy(true);
    setMsg("Unpairing all…");
    call<CallResult>("sunshine_unpair_all")
      .then((r) => {
        finish((r && r.message) || "done");
        refreshClients();
      })
      .catch((e) => finish("Error: " + errText(e)));
  }

  function saveLogin() {
    setBusy(true);
    setMsg("Setting login…");
    call<CallResult>("set_sunshine_login", { username: user, password: pass })
      .then((r) => {
        finish((r && r.message) || (r && r.ok ? "Login set" : "Failed"), true);
        if (r && r.ok) {
          if (r.state) onState(r.state);
          setPass(""); // don't retain the plaintext password once it's stored
          switchMode("pair");
          refreshClients(); // a login may already have paired devices to show
        }
      })
      .catch((e) => finish("Error: " + errText(e), true));
  }

  // Enter from either text field submits, but must honour the same guards the
  // Pair button's `disabled` does -- the keyboard has no idea the button is
  // unavailable, so without this an empty PIN would fire a doomed request.
  function submitPair() {
    if (busy || !pin.trim()) return;
    activate(doPair)();
  }

  function doPair() {
    setBusy(true);
    setMsg("Pairing…");
    call<CallResult>("sunshine_pair", { pin, name })
      .then((r) => {
        finish((r && r.message) || (r && r.ok ? "Paired" : "Failed"), true);
        if (r && r.ok) {
          setPin("");
          refreshClients();
        }
      })
      .catch((e) => finish("Error: " + errText(e), true));
  }

  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <div style={{ fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" }}>Pair a device</div>

      {/* Transient progress only ("Pairing…", "Unpairing…") -- terminal results
          go to the OK dialog in showResult(). It sits under the title rather
          than at the bottom of the modal, where Steam's on-screen keyboard
          covers it. Rendered UNCONDITIONALLY with a reserved height: as a
          `{msg ? … : null}` it appeared and vanished, reflowing everything below
          it, which reads as the modal twitching rather than as a status. The row
          now holds its space whether or not there's anything to say. */}
      <div style={{ fontSize: "0.85em", opacity: 0.9, marginBottom: "8px", minHeight: "1.2em" }}>
        {msg}
      </div>

      {mode === "login" ? (
        <div>
          <div style={{ fontSize: "0.8em", opacity: 0.7, marginBottom: "4px" }}>
            Set a Sunshine login (used to authorize pairing). This resets Sunshine's
            username/password — existing paired devices are kept.
          </div>
          <TextRow label="Username" value={user} onChange={setUser} />
          <TextRow
            label="Password"
            value={pass}
            onChange={setPass}
            password
            onEnter={() => {
              if (!busy && user.trim() && pass) activate(saveLogin)();
            }}
          />
          <DialogButton
            disabled={busy || !user.trim() || !pass}
            onPointerDown={activate(saveLogin)}
            onClick={activate(saveLogin)}
          >
            Save login
          </DialogButton>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: "0.8em", opacity: 0.7, marginBottom: "4px" }}>
            In Moonlight, select this Deck — it shows a PIN. Enter that PIN here.
          </div>
          <TextRow label="PIN" value={pin} onChange={setPin} onEnter={submitPair} />
          <TextRow label="Device name (optional)" value={name} onChange={setName} onEnter={submitPair} />
          <div style={{ display: "flex", gap: "8px" }}>
            <DialogButton
              disabled={busy || !pin.trim()}
              onPointerDown={activate(doPair)}
              onClick={activate(doPair)}
            >
              Pair
            </DialogButton>
            <DialogButton disabled={busy} onClick={() => switchMode("login")}>
              Change login
            </DialogButton>
          </div>

          <div style={{ fontWeight: 600, marginTop: "12px", marginBottom: "2px" }}>Paired devices</div>
          {clients.length === 0 ? (
            <div style={{ opacity: 0.6, fontSize: "0.85em" }}>None</div>
          ) : (
            clients.map((c) => {
              const enabled = c.enabled !== false;
              return (
                <div
                  key={c.uuid}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginTop: "4px" }}
                >
                  <span style={{ opacity: enabled ? 1 : 0.5 }}>
                    {c.name || c.uuid}
                    {enabled ? "" : " (disabled)"}
                  </span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <DialogButton
                      style={{ width: "7em" }}
                      disabled={busy}
                      onClick={() => setEnabled(c.uuid, !enabled)}
                    >
                      {enabled ? "Disable" : "Enable"}
                    </DialogButton>
                    <DialogButton style={{ width: "7em" }} disabled={busy} onClick={() => unpairOne(c.uuid)}>
                      Unpair
                    </DialogButton>
                  </div>
                </div>
              );
            })
          )}
          {clients.length > 0 ? (
            <div style={{ marginTop: "6px" }}>
              <DialogButton disabled={busy} onClick={unpairAll}>
                Unpair all
              </DialogButton>
            </div>
          ) : null}
        </div>
      )}

      <div style={{ marginTop: "10px" }}>
        <DialogButton onClick={() => closeModal && closeModal()}>
          Close
        </DialogButton>
      </div>
    </ModalRoot>
  );
};
