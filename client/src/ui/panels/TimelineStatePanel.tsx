import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import { apiClient } from "../services/api-client";
import type { SnapshotMeta, TimelineMeta, TimelineComparison } from "../../types/api";

/**
 * 时间线状态面板 —— 快照 / 分叉 / 对比。
 *
 * 这三件事是「世界可控 L3」的用户入口：
 *   快照 = 把世界的某一刻存下来
 *   分叉 = 从那一刻出发，走另一条路
 *   对比 = 看两条路走成了什么样
 *
 * 界面刻意做得朴素 —— 面板是 legacy 的一部分，先把接口和交互跑通。
 */

type Tab = "snapshots" | "compare";

export function TimelineStatePanel({
  timelineId,
  onClose,
  onChanged,
}: {
  timelineId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("snapshots");
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadSnapshots = () => {
    setLoading(true);
    apiClient
      .getTimelineSnapshots(timelineId)
      .then((r) => setSnapshots(r.snapshots))
      .catch((err) => setMessage(`加载快照失败：${err}`))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadSnapshots();
  }, [timelineId]);

  const handleCreate = async () => {
    setBusy("create");
    setMessage(null);
    try {
      await apiClient.createTimelineSnapshot(timelineId);
      loadSnapshots();
    } catch (err) {
      setMessage(`创建快照失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (snap: SnapshotMeta) => {
    if (!window.confirm(`删除快照「${snap.description || snap.id}」？`)) return;
    setBusy(snap.id);
    setMessage(null);
    try {
      await apiClient.deleteTimelineSnapshot(timelineId, snap.id);
      loadSnapshots();
    } catch (err) {
      setMessage(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async (snap: SnapshotMeta) => {
    if (!window.confirm(`恢复到「${snap.description || snap.id}」？当前进度会丢失。`)) return;
    setBusy(snap.id);
    setMessage(null);
    try {
      await apiClient.restoreTimelineSnapshot(timelineId, snap.id);
      loadSnapshots();
      onChanged?.();
    } catch (err) {
      setMessage(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleFork = async (snap: SnapshotMeta) => {
    const label = window.prompt("给这条新时间线起个名字（如「如果当时没问陆先生」）：", "");
    if (label === null) return;
    setBusy(snap.id);
    setMessage(null);
    try {
      const r = await apiClient.forkTimeline(timelineId, snap.id, label || undefined);
      setMessage(`已分叉出时间线 ${r.timelineId}`);
      loadSnapshots();
      onChanged?.();
    } catch (err) {
      setMessage(`分叉失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div style={{ display: "flex", gap: 4 }}>
            <TabButton active={tab === "snapshots"} onClick={() => setTab("snapshots")}>
              快照
            </TabButton>
            <TabButton active={tab === "compare"} onClick={() => setTab("compare")}>
              对比
            </TabButton>
          </div>
          <button onClick={onClose} style={closeBtnStyle} aria-label="关闭">
            ✕
          </button>
        </div>

        {message && <div style={messageStyle}>{message}</div>}

        <div className="custom-scrollbar" style={bodyStyle}>
          {tab === "snapshots" ? (
            <SnapshotTab
              timelineId={timelineId}
              snapshots={snapshots}
              loading={loading}
              busy={busy}
              onCreate={handleCreate}
              onDelete={handleDelete}
              onRestore={handleRestore}
              onFork={handleFork}
            />
          ) : (
            <CompareTab timelineId={timelineId} />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} style={tabBtnStyle(active)}>
      {children}
    </button>
  );
}

function SnapshotTab({
  snapshots,
  loading,
  busy,
  onCreate,
  onDelete,
  onRestore,
  onFork,
}: {
  timelineId: string;
  snapshots: SnapshotMeta[];
  loading: boolean;
  busy: string | null;
  onCreate: () => void;
  onDelete: (s: SnapshotMeta) => void;
  onRestore: (s: SnapshotMeta) => void;
  onFork: (s: SnapshotMeta) => void;
}) {
  return (
    <div>
      <button onClick={onCreate} disabled={busy === "create"} style={primaryBtnStyle}>
        {busy === "create" ? "创建中..." : "打个快照"}
      </button>

      <div style={{ marginTop: 12 }}>
        {loading ? (
          <div style={emptyStyle}>加载中...</div>
        ) : snapshots.length === 0 ? (
          <div style={emptyStyle}>
            还没有快照。打个快照，就能从这一刻分叉出另一条路。
          </div>
        ) : (
          snapshots.map((s) => (
            <div key={s.id} style={itemRowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={itemTitleStyle}>
                  {s.description || "（无描述）"}
                </div>
                <div style={itemMetaStyle}>
                  第 {s.gameDay} 天 · 第 {s.gameTick} tick ·{" "}
                  {new Date(s.createdAt).toLocaleString()}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => onFork(s)} disabled={busy === s.id} style={smallBtnStyle}>
                  分叉
                </button>
                <button onClick={() => onRestore(s)} disabled={busy === s.id} style={smallBtnStyle}>
                  恢复
                </button>
                <button onClick={() => onDelete(s)} disabled={busy === s.id} style={smallBtnStyle}>
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CompareTab({ timelineId }: { timelineId: string }) {
  const [timelines, setTimelines] = useState<TimelineMeta[]>([]);
  const [b, setB] = useState<string>("");
  const [comparison, setComparison] = useState<TimelineComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getTimelines()
      .then((r) => {
        setTimelines(r.timelines);
        // 默认拿一条不是当前的时间线来比
        const other = r.timelines.find((t) => t.id !== timelineId);
        if (other) setB(other.id);
      })
      .catch((err) => setMessage(`加载时间线失败：${err}`));
  }, [timelineId]);

  const handleCompare = async () => {
    if (!b) return;
    setBusy(true);
    setMessage(null);
    try {
      setComparison(await apiClient.compareTimelines(timelineId, b));
    } catch (err) {
      setMessage(`对比失败：${err instanceof Error ? err.message : String(err)}`);
      setComparison(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select value={b} onChange={(e) => setB(e.target.value)} style={selectStyle}>
          {timelines
            .filter((t) => t.id !== timelineId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.label ? `${t.label} (${t.id})` : t.id}
              </option>
            ))}
        </select>
        <button onClick={handleCompare} disabled={busy || !b} style={primaryBtnStyle}>
          {busy ? "对比中..." : "对比"}
        </button>
      </div>

      {message && <div style={{ ...messageStyle, marginTop: 10 }}>{message}</div>}

      {comparison && (
        <div style={{ marginTop: 14 }}>
          <div style={compareHeaderStyle}>
            <div>
              <div style={itemTitleStyle}>{comparison.timelineA.label || comparison.timelineA.id}</div>
              <div style={itemMetaStyle}>
                第 {comparison.timelineA.lastGameTime.day} 天 · {comparison.timelineA.tickCount} 帧 ·{" "}
                {comparison.eventCounts.a} 事件
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={itemTitleStyle}>{comparison.timelineB.label || comparison.timelineB.id}</div>
              <div style={itemMetaStyle}>
                第 {comparison.timelineB.lastGameTime.day} 天 · {comparison.timelineB.tickCount} 帧 ·{" "}
                {comparison.eventCounts.b} 事件
              </div>
            </div>
          </div>

          {comparison.forkedFrom && (
            <div style={forkNoteStyle}>
              分叉自 {comparison.forkedFrom.timelineId} · 第 {comparison.forkedFrom.day} 天第{" "}
              {comparison.forkedFrom.tick} tick
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <div style={sectionTitleStyle}>角色状态</div>
            {comparison.characters.length === 0 ? (
              <div style={emptyStyle}>无差异</div>
            ) : (
              comparison.characters.map((c) => (
                <div key={c.characterId} style={diffRowStyle}>
                  <div style={diffCharStyle}>{c.characterId}</div>
                  {c.onlyIn ? (
                    <div style={diffValueStyle}>
                      只在 {c.onlyIn === "a" ? "A" : "B"} 中存在
                    </div>
                  ) : (
                    c.fields.map((f) => (
                      <div key={f.field} style={diffValueStyle}>
                        {f.field}：A = {String(f.a)}，B = {String(f.b)}
                      </div>
                    ))
                  )}
                </div>
              ))
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={sectionTitleStyle}>记忆</div>
            {comparison.memories.length === 0 ? (
              <div style={emptyStyle}>无差异</div>
            ) : (
              comparison.memories.map((m) => (
                <div key={m.characterId} style={diffRowStyle}>
                  <div style={diffCharStyle}>{m.characterId}</div>
                  <div style={diffValueStyle}>
                    共有 {m.common}，只 A 有 {m.onlyInA}，只 B 有 {m.onlyInB}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 样式 ───────────────────────────────────────────────────────────────────

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 10001,
};

const panelStyle: CSSProperties = {
  width: 560,
  maxWidth: "92vw",
  maxHeight: "82vh",
  background: "rgba(14, 18, 36, 0.98)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 16,
  boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  color: "#e0e0e0",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#a8b3d4",
  fontSize: 16,
  cursor: "pointer",
  padding: "4px 8px",
  lineHeight: 1,
};

const tabBtnStyle = (active: boolean): CSSProperties => ({
  background: active ? "rgba(90,130,255,0.22)" : "transparent",
  border: "1px solid " + (active ? "rgba(120,160,255,0.5)" : "transparent"),
  color: active ? "#cdd8ff" : "#8b95b8",
  padding: "4px 12px",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
});

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 14,
  overflowY: "auto",
  overflowX: "hidden",
};

const primaryBtnStyle: CSSProperties = {
  background: "rgba(90,130,255,0.24)",
  border: "1px solid rgba(120,160,255,0.45)",
  color: "#cdd8ff",
  padding: "6px 14px",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};

const smallBtnStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#b9c2e0",
  padding: "3px 9px",
  borderRadius: 6,
  fontSize: 11,
  cursor: "pointer",
};

const selectStyle: CSSProperties = {
  flex: 1,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "#d0d6ef",
  padding: "5px 8px",
  borderRadius: 6,
  fontSize: 12,
};

const messageStyle: CSSProperties = {
  padding: "8px 14px",
  fontSize: 12,
  color: "#ffcf8f",
  background: "rgba(255,180,60,0.08)",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const emptyStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  padding: "10px 2px",
  lineHeight: 1.6,
};

const itemRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.035)",
  marginBottom: 6,
};

const itemTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#d0d6ef",
  lineHeight: 1.3,
};

const itemMetaStyle: CSSProperties = {
  fontSize: 11,
  color: "#7c87ad",
  lineHeight: 1.4,
  marginTop: 2,
};

const compareHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.035)",
};

const forkNoteStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: "#7c87ad",
  padding: "4px 10px",
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#8b95b8",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 5,
};

const diffRowStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  background: "rgba(255,255,255,0.03)",
  marginBottom: 4,
};

const diffCharStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#b9c2e0",
  marginBottom: 2,
};

const diffValueStyle: CSSProperties = {
  fontSize: 11,
  color: "#8b95b8",
  lineHeight: 1.5,
  wordBreak: "break-word",
};
