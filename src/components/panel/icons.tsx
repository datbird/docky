import { VFC } from "react";
import { DialogButton } from "decky-frontend-lib";

export function DockIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 5h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v7h16V7H4z" />
    </svg>
  );
}

// The Docky brand mark: a navy badge with a white "dock" arch, a blue screen dot,
// and a blue dock cradle. Used as the plugin icon. Sized to fill the icon slot
// (badge near full-bleed, mark enlarged) so it reads at the same scale as other
// Decky plugin icons; the brighter badge + border keep it visible on the dark
// panel background, where the old darker navy blended in.
export function DockyLogo() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 32 32">
      <defs>
        <linearGradient id="dockyBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a3548" />
          <stop offset="1" stopColor="#1a212d" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#dockyBg)" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="7.5" fill="none" stroke="#4a5a78" strokeWidth="1" />
      <path d="M8 24 V11 Q8 5.3 13.7 5.3 H18.3 Q24 5.3 24 11 V24"
            fill="none" stroke="#f1f4fa" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="14.8" r="3.4" fill="#5b7cf0" />
      <path d="M5.3 21.7 Q16 26.9 26.7 21.7" fill="none" stroke="#5b7cf0" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}

// Small on/off "LED" shown on buttons whose task carries a live boolean state.
export const StatusDot: VFC<{ on: boolean }> = ({ on }) => (
  <span
    style={{
      display: "inline-block",
      width: "10px",
      height: "10px",
      borderRadius: "50%",
      flexShrink: 0,
      background: on ? "#52d669" : "#555",
      boxShadow: on ? "0 0 6px #52d669" : "none",
    }}
  />
);

export function InfoIcon() {
  return (
    <svg width="1.1em" height="1.1em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
    </svg>
  );
}

export function ReloadIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.34.68.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.58-.24 1.12-.56 1.62-.94l2.39.96c.26.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
    </svg>
  );
}

export function RestartIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h12v12H6z" />
    </svg>
  );
}

// Compact icon button for action rows. Omit `label` for an icon-only button.
export const IconButton: VFC<{
  label?: string;
  flex?: number;
  disabled?: boolean;
  onClick: () => void;
  children: any;
}> = ({ label, flex, disabled, onClick, children }) => (
  <DialogButton
    disabled={disabled}
    onClick={onClick}
    style={{
      flex: flex ?? 1,
      minWidth: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "6px",
      padding: "6px",
    }}
  >
    {children}
    {label ? <span style={{ fontSize: "0.85em" }}>{label}</span> : null}
  </DialogButton>
);
