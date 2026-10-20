import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../services/api-client";
import type { GlobalStateEntry, LocationState, ModelConfigResponse } from "../services/api-client";

type TabKey = "batch" | "state" | "config";
type BatchUnit = "ticks" | "days";

const MAX_TICKS = 200;
const MAX_DAYS = 100;

export function AdvancedPanel({
  onClose,
  worldId,
  timelineId,
  simBusy,
}: {
  onClose: () => void;
  worldId: string | null;
  timelineId: string | null;
  simBusy: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>("batch");
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [unit, setUnit] = useState<BatchUnit>("ticks");
  const [count, setCount] = useState(10);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [eventTotal, setEventTotal] = useState(0);
  const [needsReload, setNeedsReload] = useState(false);
  const stopRef = useRef(false);

  const [globalState, setGlobalState] = useState<GlobalStateEntry[] | null>(null);
  const [locationStates, setLocationStates] = useState<LocationState[] | null>(null);
  const [stateLoading, setStateLoading] = useState(false);

  const [modelConfig, setModelConfig] = useState<ModelConfigResponse | null>(null);

  // Stop a client-side tick loop if the panel is closed mid-run.
  useEffect(() => () => { stopRef.current = true; }, []);

  const showFlash = (kind: "ok" | "err", text: string) => {
    setFlash({ kind, text });
    setTimeout(() => setFlash(null), 5000);
  };

/*__CHUNK2__*/

  const runBatch = async () => {
    if (running || !worldId || !timelineId) return;
    const max = unit === "ticks" ? MAX_TICKS : MAX_DAYS;
    const total = Math.floor(count);
    if (!Number.isFinite(total) || total < 1 || total > max) {
      showFlash("err", t("advanced.invalidCount", { max }));
      return;
    }

    stopRef.current = false;
    setRunning(true);
    setStopping(false);
    setNeedsReload(false);
    setEventTotal(0);
    setProgress({ current: 0, total });
    let events = 0;

    try {
      if (unit === "days") {
        // Server-side loop; poll its status for progress.
        const poll = window.setInterval(async () => {
          try {
            const status = await apiClient.getSimulationStatus();
            if (status.progress) setProgress(status.progress);
          } catch { /* polling is best-effort */ }
        }, 2000);
        try {
          const resp = await apiClient.simulateDays(total);
          events = resp.eventCount;
          if (resp.paused) showFlash("ok", t("advanced.paused", { ticks: resp.ticksCompleted ?? 0, events }));
        } finally {
          window.clearInterval(poll);
        }
      } else {
        for (let i = 0; i < total; i++) {
          if (stopRef.current) {
            showFlash("ok", t("advanced.paused", { ticks: i, events }));
            break;
          }
          const resp = await apiClient.simulateTick({ worldId, timelineId });
          events += resp.eventCount;
          setEventTotal(events);
          setProgress({ current: i + 1, total });
        }
      }
    } catch (err) {
      showFlash("err", t("advanced.failed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setEventTotal(events);
      setRunning(false);
      setStopping(false);
      setNeedsReload(true);
    }
  };

  const stopBatch = async () => {
    stopRef.current = true;
    setStopping(true);
    if (unit === "days") {
      try { await apiClient.pauseSimulation(); } catch { /* the loop checks the flag anyway */ }
    }
  };

  const loadState = async () => {
    setStateLoading(true);
    try {
      const locations = await apiClient.getLocations();
      const [global, ...states] = await Promise.all([
        apiClient.getGlobalState(),
        ...locations.map((loc) => apiClient.getLocationState(loc.id)),
      ]);
      setGlobalState(global);
      setLocationStates(states);
    } catch (err) {
      showFlash("err", t("advanced.failed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setStateLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "state" && locationStates === null && !stateLoading) void loadState();
    if (tab === "config" && modelConfig === null) {
      apiClient.getModelConfig()
        .then(setModelConfig)
        .catch((err) => showFlash("err", t("advanced.failed", { error: err instanceof Error ? err.message : String(err) })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const roleLabel = (role: string) => t(`advanced.role.${role}`, { defaultValue: role });

  const noContext = !worldId || !timelineId;
  const batchDisabled = running || noContext || (simBusy && !running);

  return (
    <div style={backdropStyle} onClick={running ? undefined : onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚙️</span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{t("advanced.title")}</span>
            <span style={{ opacity: 0.55, fontSize: 11 }}>{t("advanced.subtitle")}</span>
          </div>
          <button onClick={onClose} disabled={running} style={closeBtnStyle} aria-label={t("advanced.close")}>×</button>
        </div>

        <div style={tabsStyle}>
          {(["batch", "state", "config"] as TabKey[]).map((key) => (
            <button key={key} onClick={() => setTab(key)} style={tabBtnStyle(tab === key)}>
              {t(`advanced.tab.${key}`)}
            </button>
          ))}
        </div>

        <div style={bodyStyle}>
          {tab === "batch" && (
            <div style={sectionStyle}>
              <p style={hintStyle}>{t("advanced.batchHint")}</p>
              {noContext && <p style={{ ...hintStyle, color: "#ffb0b0" }}>{t("advanced.noContext")}</p>}
              {simBusy && !running && <p style={{ ...hintStyle, color: "#ffe08a" }}>{t("advanced.simBusy")}</p>}

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="number"
                  min={1}
                  max={unit === "ticks" ? MAX_TICKS : MAX_DAYS}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  disabled={running}
                  style={{ ...inputStyle, width: 90 }}
                  aria-label={t("advanced.countLabel")}
                />
                <div style={{ display: "inline-flex", borderRadius: 999, overflow: "hidden", border: "1px solid rgba(255,255,255,0.15)" }}>
                  {(["ticks", "days"] as BatchUnit[]).map((u) => (
                    <button key={u} onClick={() => { setUnit(u); setCount(u === "ticks" ? 10 : 1); }} disabled={running}
                      style={{ ...unitBtnStyle(unit === u) }}>
                      {t(`advanced.unit.${u}`)}
                    </button>
                  ))}
                </div>
                <span style={{ fontSize: 11, opacity: 0.5 }}>{t("advanced.maxHint", { max: unit === "ticks" ? MAX_TICKS : MAX_DAYS })}</span>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={runBatch} disabled={batchDisabled} style={primaryBtnStyle(batchDisabled)}>
                  {running ? t("advanced.running") : t("advanced.start")}
                </button>
                {running && (
                  <button onClick={stopBatch} disabled={stopping} style={dangerBtnStyle(stopping)}>
                    {stopping ? t("advanced.stopping") : t("advanced.stop")}
                  </button>
                )}
              </div>

              {progress && (
                <div>
                  <div style={barTrackStyle}>
                    <div style={{ ...barFillStyle, width: `${progress.total ? Math.round(100 * progress.current / progress.total) : 0}%` }} />
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>
                    {t("advanced.progress", { current: progress.current, total: progress.total, events: eventTotal })}
                  </div>
                </div>
              )}

              {needsReload && !running && (
                <button onClick={() => window.location.reload()} style={primaryBtnStyle(false)}>
                  {t("advanced.reload")}
                </button>
              )}
            </div>
          )}

          {tab === "state" && (
            <div style={sectionStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{t("advanced.stateHint")}</span>
                <button onClick={loadState} disabled={stateLoading} style={smallBtnStyle}>{t("advanced.refresh")}</button>
              </div>

              {stateLoading && <span style={hintStyle}>{t("advanced.loading")}</span>}

              {globalState && (
                <div>
                  <div style={groupTitleStyle}>{t("advanced.globalState")}</div>
                  {globalState.length === 0
                    ? <div style={emptyStyle}>{t("advanced.empty")}</div>
                    : globalState.map((entry) => (
                        <div key={entry.key} style={rowStyle}>
                          <span style={keyStyle}>{entry.key}</span>
                          <span style={{ fontSize: 12 }}>{entry.value}</span>
                        </div>
                      ))}
                </div>
              )}

              {locationStates?.map((loc) => (
                <div key={loc.location.id}>
                  <div style={groupTitleStyle}>{loc.location.name}</div>
                  {loc.characters.length === 0 && loc.objects.length === 0 && (
                    <div style={emptyStyle}>{t("advanced.empty")}</div>
                  )}
                  {loc.characters.map((c) => (
                    <div key={c.id} style={rowStyle}>
                      <span style={keyStyle}>👤 {c.name}</span>
                      <span style={{ fontSize: 12, opacity: 0.85 }}>{c.action || t("advanced.idle")}</span>
                    </div>
                  ))}
                  {loc.objects.map((o) => (
                    <div key={o.objectId} style={rowStyle}>
                      <span style={keyStyle}>📦 {o.objectId}</span>
                      <span style={{ fontSize: 12, opacity: 0.85 }}>
                        {o.state}{o.stateDescription ? ` · ${o.stateDescription}` : ""}
                        {o.currentUsers.length > 0 ? ` · ${o.currentUsers.join(", ")}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {tab === "config" && (
            <div style={sectionStyle}>
              <p style={hintStyle}>{t("advanced.configHint")}</p>
              {!modelConfig && <span style={hintStyle}>{t("advanced.loading")}</span>}
              {modelConfig?.roles.map((role) => (
                <div key={role.role} style={configRowStyle}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{roleLabel(role.role)}</div>
                  <div style={{ fontSize: 12, opacity: 0.9 }}>{role.model || t("advanced.notSet")}</div>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>
                    {role.host || t("advanced.notSet")}
                    {role.provider ? ` · ${role.provider}` : ""}
                    {" · "}
                    {role.hasApiKey ? t("advanced.keySet") : t("advanced.keyMissing")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {flash && (
          <div
            role="status"
            style={{
              ...flashStyle,
              background: flash.kind === "ok" ? "rgba(0,184,148,0.18)" : "rgba(231,76,60,0.22)",
              color: flash.kind === "ok" ? "#8df3cf" : "#ffb0b0",
              border: `1px solid ${flash.kind === "ok" ? "rgba(0,184,148,0.45)" : "rgba(231,76,60,0.45)"}`,
            }}
          >
            {flash.text}
          </div>
        )}
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  top: "var(--top-ui-offset, 0px)",
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(4,6,12,0.55)",
  zIndex: 500,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "0 16px 16px",
  overflowY: "auto",
};

const panelStyle: CSSProperties = {
  width: "min(560px, calc(100% - 32px))",
  maxHeight: "calc(100vh - var(--top-ui-offset, 0px) - 16px)",
  background: "linear-gradient(180deg, rgba(16,20,36,0.98), rgba(12,14,26,0.98))",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 14,
  boxShadow: "0 28px 70px rgba(0,0,0,0.55)",
  color: "#e0e0e0",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

const headerStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#e0e0e0",
  fontSize: 22,
  cursor: "pointer",
  lineHeight: 1,
  padding: 0,
  width: 28,
  height: 28,
  opacity: 0.7,
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "10px 14px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const bodyStyle: CSSProperties = { padding: 14, overflowY: "auto" };

const sectionStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 10 };

const hintStyle: CSSProperties = { fontSize: 11, opacity: 0.6, margin: 0, lineHeight: 1.5 };

const inputStyle: CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  color: "#e8e8ea",
  padding: "4px 8px",
  fontSize: 12,
};

const smallBtnStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "#e0e0e0",
  borderRadius: 6,
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
};

const barTrackStyle: CSSProperties = {
  height: 6,
  borderRadius: 999,
  background: "rgba(255,255,255,0.08)",
  overflow: "hidden",
};

const barFillStyle: CSSProperties = {
  height: "100%",
  background: "linear-gradient(90deg, rgba(116,185,255,0.8), rgba(165,91,255,0.8))",
  transition: "width 0.3s",
};

const groupTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.85,
  margin: "6px 0 4px",
};

const emptyStyle: CSSProperties = { fontSize: 11, opacity: 0.45 };

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  padding: "4px 0",
  borderBottom: "1px solid rgba(255,255,255,0.05)",
};

const keyStyle: CSSProperties = { fontSize: 12, opacity: 0.7, minWidth: 120, flexShrink: 0 };

const configRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "8px 10px",
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
};

const flashStyle: CSSProperties = {
  margin: "0 14px 14px",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 12,
};

function tabBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? "rgba(116,185,255,0.18)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${active ? "rgba(116,185,255,0.45)" : "rgba(255,255,255,0.1)"}`,
    color: active ? "#dff3ff" : "#e0e0e0",
    borderRadius: 999,
    padding: "4px 12px",
    fontSize: 12,
    cursor: "pointer",
  };
}

function unitBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? "rgba(116,185,255,0.22)" : "transparent",
    border: "none",
    color: active ? "#dff3ff" : "rgba(255,255,255,0.6)",
    padding: "4px 12px",
    fontSize: 12,
    cursor: "pointer",
  };
}

function primaryBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "rgba(116,185,255,0.1)" : "rgba(116,185,255,0.22)",
    border: "1px solid rgba(116,185,255,0.5)",
    color: "#eaf5ff",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
    alignSelf: "flex-start",
  };
}

function dangerBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: "rgba(231,76,60,0.18)",
    border: "1px solid rgba(231,76,60,0.5)",
    color: "#ffd0d0",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? "wait" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
