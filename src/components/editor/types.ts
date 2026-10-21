import { Config } from "../../util";

export type TabId = "actions" | "modes" | "favorites" | "fan" | "tdp" | "sunshine" | "triggers";

// Dropdown options for the saved-profile task fields.
export type ProfileOpts = { fan: { data: string; label: string }[]; tdp: { data: string; label: string }[] };

export type Mutate = (fn: (n: Config) => void) => void;

export interface TabProps {
  cfg: Config;
  mutate: Mutate;
  busy: boolean;
}

// Selection lives in the editor so it survives switching tabs.
export interface DrillProps extends TabProps {
  sel: string | null;
  setSel: (id: string | null) => void;
}
