import { VFC, useState } from "react";
import { DialogButton, Field, DropdownItem, Focusable } from "decky-frontend-lib";
import { Favorite } from "../../util";
import { TabProps } from "./types";

// Pick an action/mode (encoded "kind:id") not yet favorited, and add it.
const AddFavorite: VFC<{
  options: { data: string; label: string }[];
  busy: boolean;
  onAdd: (value: string) => void;
}> = ({ options, busy, onAdd }) => {
  const [sel, setSel] = useState<string>(options[0] ? options[0].data : "");
  // Keep the selection valid as the option list shrinks after each add.
  const cur = options.some((o) => o.data === sel) ? sel : options[0] ? options[0].data : "";
  return (
    <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <DropdownItem
          label="Item"
          rgOptions={options}
          selectedOption={cur}
          onChange={(o) => setSel(o.data)}
        />
      </div>
      <DialogButton disabled={busy || !cur} onClick={() => cur && onAdd(cur)}>
        + Add
      </DialogButton>
    </Focusable>
  );
};

// Small fixed-width button for the favorite reorder/remove controls.
const MiniButton: VFC<{ disabled?: boolean; width: string; onClick: () => void; children: any }> = ({
  disabled,
  width,
  onClick,
  children,
}) => (
  <DialogButton
    disabled={disabled}
    onClick={onClick}
    style={{ minWidth: 0, width, padding: "6px 4px", textAlign: "center" }}
  >
    {children}
  </DialogButton>
);

export const FavoritesTab: VFC<TabProps> = ({ cfg, mutate, busy }) => {
  const cfgActions = cfg.actions || {};
  const cfgModes = cfg.modes || {};
  const actionIds = Object.keys(cfgActions);
  const modeIds = Object.keys(cfgModes);
  const favs = cfg.favorites || [];
  const key = (f: Favorite) => f.kind + ":" + f.id;
  const have: Record<string, boolean> = {};
  favs.forEach((f) => (have[key(f)] = true));
  const options = actionIds
    .filter((id) => !have["action:" + id])
    .map((id) => ({ data: "action:" + id, label: "Action — " + (cfgActions[id].name || id) }))
    .concat(
      modeIds
        .filter((id) => !have["mode:" + id])
        .map((id) => ({ data: "mode:" + id, label: "Mode — " + (cfgModes[id].name || id) }))
    );

  function swap(i: number, j: number) {
    mutate((n) => {
      const a = n.favorites!;
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    });
  }

  return (
    <div>
      <div style={{ fontWeight: 700, margin: "2px 0 6px" }}>Favorites</div>
      <div style={{ fontSize: "0.8em", opacity: 0.6, marginBottom: "8px" }}>
        Pinned actions and modes appear in the panel’s Favorites section, in this order.
        Use ▲▼ to sort.
      </div>
      {favs.length === 0 ? (
        <div style={{ opacity: 0.6, marginBottom: "8px" }}>No favorites yet.</div>
      ) : (
        favs.map((f, i) => {
          const item = f.kind === "action" ? cfgActions[f.id] : cfgModes[f.id];
          const name = item ? item.name || f.id : f.id;
          const tag = f.kind === "action" ? "Action" : "Mode";
          return (
            <Field
              key={key(f)}
              label={tag + ": " + name + (item ? "" : " (missing)")}
              bottomSeparator="none"
            >
              <Focusable flow-children="horizontal" style={{ display: "flex", gap: "4px" }}>
                <MiniButton width="3em" disabled={busy || i === 0} onClick={() => swap(i, i - 1)}>
                  ▲
                </MiniButton>
                <MiniButton
                  width="3em"
                  disabled={busy || i === favs.length - 1}
                  onClick={() => swap(i, i + 1)}
                >
                  ▼
                </MiniButton>
                <MiniButton
                  width="5.5em"
                  disabled={busy}
                  onClick={() => mutate((n) => { n.favorites!.splice(i, 1); })}
                >
                  Remove
                </MiniButton>
              </Focusable>
            </Field>
          );
        })
      )}
      <div style={{ fontWeight: 600, margin: "12px 0 2px" }}>Add a favorite</div>
      {options.length === 0 ? (
        <div style={{ opacity: 0.6 }}>
          {actionIds.length + modeIds.length === 0
            ? "Create actions or modes first."
            : "Everything is already favorited."}
        </div>
      ) : (
        <AddFavorite
          options={options}
          busy={busy}
          onAdd={(value) =>
            mutate((n) => {
              const idx = value.indexOf(":");
              const kind = value.slice(0, idx) as Favorite["kind"];
              const id = value.slice(idx + 1);
              n.favorites = n.favorites || [];
              n.favorites.push({ kind, id });
            })
          }
        />
      )}
    </div>
  );
};
