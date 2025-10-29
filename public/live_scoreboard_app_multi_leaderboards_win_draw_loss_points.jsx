import React, { useEffect, useMemo, useState } from "react";
// NOTE: framer-motion is intentionally not used to avoid potential prod minified errors from version/SSR mismatches
import {
  Plus,
  Trophy,
  Table,
  Upload,
  Download,
  Users,
  Activity,
  Undo2,
  Trash2,
  ChevronLeft,
  Edit,
  Trash,
  DoorOpen,
  X,
  Share2,
  Lock,
  Unlock,
  Image as ImageIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

/**********************
 * Types
 **********************/
type Player = { id: string; name: string; photo?: string | null };
type ActivityType = { id: string; name: string };

// Multi-participant results per score entry (with legacy compatibility)
export type ScoreEntry = {
  id: string;
  activityId: string;
  ts: number;
  participants?: { playerId: string; points: number }[];
  // legacy (single player)
  playerId?: string;
  points?: number;
};

type BoardState = {
  players: Player[];
  activities: ActivityType[];
  scores: ScoreEntry[];
};

type Board = { id: string; name: string; ownerId: string; editToken: string; state: BoardState };

type RootState = {
  boards: Board[];
  selectedBoardId: string | null;
  currentUser: { id: string; name: string };
};

/**********************
 * Helpers
 **********************/
const uid = () => Math.random().toString(36).slice(2, 9);
const STORAGE_KEY = "live-scoreboard-multi-v7"; // photo UI + bugfix

const MAX_PHOTO_SIZE = 256; // px bounding box
const PHOTO_QUALITY = 0.7; // JPEG quality

const getURL = () => (typeof window !== "undefined" ? window.location.origin + window.location.pathname : "");
const getParam = (key: string) => {
  if (typeof window === "undefined") return null;
  const u = new URL(window.location.href);
  return u.searchParams.get(key);
};
const setParam = (key: string, val: string | null) => {
  if (typeof window === "undefined") return;
  const u = new URL(window.location.href);
  if (val === null) u.searchParams.delete(key); else u.searchParams.set(key, val);
  window.history.replaceState({}, "", u.toString());
};

function usePersistentState<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
  }, [key, state]);
  return [state, setState] as const;
}

function useBroadcast<T>(channelName: string, state: T, setState: (v: T) => void) {
  useEffect(() => {
    const bc: BroadcastChannel | null = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;
    if (!bc) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === "SYNC_STATE") setState(e.data.payload as T);
    };
    bc.addEventListener("message", onMsg);
    return () => bc.removeEventListener("message", onMsg);
  }, [channelName, setState]);

  useEffect(() => {
    const bc: BroadcastChannel | null = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;
    if (!bc) return;
    bc.postMessage({ type: "SYNC_STATE", payload: state });
  }, [channelName, state]);
}

// Image helpers (resize & compress to dataURL)
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

async function resizeImageDataUrl(dataUrl: string, maxSide = MAX_PHOTO_SIZE, quality = PHOTO_QUALITY): Promise<string> {
  // Create HTMLImageElement
  const img = new Image();
  img.src = dataUrl;
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = (e) => rej(e); });
  const { width, height } = img;
  if (!width || !height) return dataUrl;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  if (scale === 1) return dataUrl; // already small
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  // Prefer JPEG to cap size
  return canvas.toDataURL("image/jpeg", quality);
}

const defaultBoardState: BoardState = {
  players: [ { id: uid(), name: "Alex", photo: null }, { id: uid(), name: "Sam", photo: null } ],
  activities: [ { id: uid(), name: "Sjoelen" }, { id: uid(), name: "Tafeltennis" } ],
  scores: [],
};

const defaultRootState = (userId: string, userName: string): RootState => ({
  boards: [ { id: uid(), name: "Toernooi 1", ownerId: userId, editToken: uid()+uid(), state: defaultBoardState } ],
  selectedBoardId: null,
  currentUser: { id: userId, name: userName },
});

function prettyDate(ts: number) { return new Date(ts).toLocaleString(); }

// Normalize any entry to participants[]
function normalizeParticipants(e: ScoreEntry): { playerId: string; points: number }[] {
  if (e.participants && Array.isArray(e.participants)) return e.participants;
  if (e.playerId && typeof e.points === "number") return [{ playerId: e.playerId, points: e.points }];
  return [];
}

// Compute standings delta for an entry according to rules:
// Win = 2 pts (single top scorer), Draw = 1 pt for each top-tied player, Loss = 0
function computeStandingsDelta(e: ScoreEntry): Map<string, number> {
  const parts = normalizeParticipants(e);
  const delta = new Map<string, number>();
  if (parts.length < 2) return delta; // cannot score standings from <2 players
  const maxPts = Math.max(...parts.map(p => p.points));
  const top = parts.filter(p => p.points === maxPts);
  if (top.length === 1) {
    delta.set(top[0].playerId, 2);
  } else {
    for (const p of top) delta.set(p.playerId, 1);
  }
  return delta;
}

function scoreline(e: ScoreEntry, playersById: Record<string, Player>) {
  const parts = normalizeParticipants(e);
  const names = parts.map(p => playersById[p.playerId]?.name ?? "?");
  const pts = parts.map(p => String(p.points));
  const nameLine = names.join(" vs ");
  const pointsLine = pts.join("-");
  return { nameLine, pointsLine };
}

/**********************
 * Sharing Adapter (pluggable)
 **********************/
type SharedBoardRecord = { id: string; payload: Board };

type Adapter = {
  getBoard: (id: string) => Promise<Board | null>;
  upsertBoard: (board: Board) => Promise<void>;
  subscribeBoard?: (id: string, cb: (board: Board) => void) => () => void;
};

const LocalAdapter: Adapter = {
  async getBoard(id) {
    try {
      const raw = localStorage.getItem(`shared-board:${id}`);
      if (!raw) return null;
      const rec: SharedBoardRecord = JSON.parse(raw);
      return rec.payload;
    } catch { return null; }
  },
  async upsertBoard(board) {
    const rec: SharedBoardRecord = { id: board.id, payload: board };
    localStorage.setItem(`shared-board:${board.id}`, JSON.stringify(rec));
  },
  subscribeBoard(id, cb) {
    const onStorage = (e: StorageEvent) => {
      if (e.key === `shared-board:${id}` && e.newValue) {
        try { const rec: SharedBoardRecord = JSON.parse(e.newValue); cb(rec.payload); } catch {}
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }
};

let adapter: Adapter = LocalAdapter;

/**********************
 * Root App (Board Picker → Board View)
 **********************/
export default function MultiScoreboardApp() {
  // bootstrap user
  const bootUser = (() => {
    try {
      const raw = localStorage.getItem("scoreboard-user");
      if (raw) return JSON.parse(raw) as { id: string; name: string };
    } catch {}
    const id = uid()+uid();
    const name = "Beheerder";
    const obj = { id, name };
    localStorage.setItem("scoreboard-user", JSON.stringify(obj));
    return obj;
  })();

  const [root, setRoot] = usePersistentState<RootState>(STORAGE_KEY, defaultRootState(bootUser.id, bootUser.name));
  useEffect(()=>{ if (root.currentUser.id !== bootUser.id) setRoot({ ...root, currentUser: bootUser }); }, []); // keep current user in state

  // open-by-link support (load board if ?board is present)
  useEffect(() => {
    const boardId = getParam("board");
    if (!boardId) return;
    (async () => {
      const shared = await adapter.getBoard(boardId);
      if (shared) {
        const exists = root.boards.some(b => b.id === shared.id);
        const boards = exists ? root.boards.map(b => (b.id === shared.id ? shared : b)) : [shared, ...root.boards];
        setRoot({ ...root, boards, selectedBoardId: shared.id });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect selected board id into the URL ALWAYS (no conditional Hooks)
  useEffect(() => {
    setParam("board", root.selectedBoardId);
    if (!root.selectedBoardId) setParam("token", null);
  }, [root.selectedBoardId]);

  const selectBoard = (id: string) => setRoot({ ...root, selectedBoardId: id });
  const backToPicker = () => { setParam("board", null); setParam("token", null); setRoot({ ...root, selectedBoardId: null }); };

  const addBoard = (name: string) => {
    const newBoard: Board = { id: uid(), name: name.trim() || `Leaderboard ${root.boards.length + 1}`, ownerId: root.currentUser.id, editToken: uid()+uid(), state: { players: [], activities: [], scores: [] } };
    setRoot({ ...root, boards: [newBoard, ...root.boards], selectedBoardId: newBoard.id });
    adapter.upsertBoard(newBoard);
  };
  const renameBoard = (id: string, name: string) => {
    const next = root.boards.map(b => b.id === id ? { ...b, name } : b);
    setRoot({ ...root, boards: next });
    const b = next.find(x=>x.id===id); if (b) adapter.upsertBoard(b);
  };
  const deleteBoard = (id: string) => {
    const nextBoards = root.boards.filter(b => b.id !== id);
    const nextSelected = root.selectedBoardId === id ? null : root.selectedBoardId;
    setRoot({ ...root, boards: nextBoards, selectedBoardId: nextSelected });
  };

  const exportAll = () => {
    const blob = new Blob([JSON.stringify(root, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `scoreboards-export-${new Date().toISOString().slice(0,19)}.json`; a.click(); URL.revokeObjectURL(url);
  };
  const importAll = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { const next = JSON.parse(String(reader.result)) as RootState; setRoot(next); }
      catch { alert("Kon JSON niet lezen."); }
    }; reader.readAsText(file);
  };

  const currentBoard = root.boards.find(b => b.id === root.selectedBoardId) || null;
  if (currentBoard) {
    const canEdit = root.currentUser.id === currentBoard.ownerId || getParam("token") === currentBoard.editToken;

    return (
      <BoardView
        key={currentBoard.id}
        board={currentBoard}
        canEdit={!!canEdit}
        currentUser={root.currentUser}
        onBack={backToPicker}
        onUpdate={(state) => { const next = root.boards.map(b => b.id === currentBoard.id ? { ...b, state } : b); setRoot({ ...root, boards: next }); const b = next.find(x=>x.id===currentBoard.id)!; adapter.upsertBoard(b); }}
        onRename={(name) => renameBoard(currentBoard.id, name)}
        onExport={() => {
          const blob = new Blob([JSON.stringify(currentBoard, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob); const a = document.createElement("a");
          a.href = url; a.download = `scoreboard-${currentBoard.name}.json`; a.click(); URL.revokeObjectURL(url);
        }}
        onCopyLinks={() => {
          const viewUrl = `${getURL()}?board=${currentBoard.id}`;
          const manageUrl = `${getURL()}?board=${currentBoard.id}&token=${currentBoard.editToken}`;
          navigator.clipboard.writeText(`Kijklink: ${viewUrl}\nBeheerlink: ${manageUrl}`);
          alert("Kijklink en beheerlink naar klembord gekopieerd.");
        }}
        onTransferOwner={(newOwnerId) => {
          const next = root.boards.map(b => b.id === currentBoard.id ? { ...b, ownerId: newOwnerId } : b);
          setRoot({ ...root, boards: next });
          const b = next.find(x=>x.id===currentBoard.id)!; adapter.upsertBoard(b);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-white p-6">
      <div className="mx-auto max-w-5xl">
        <div className="opacity-100 translate-y-0 transition-all">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Kies een leaderboard</h1>
              <p className="text-slate-600">Deel toernooien via links. Alleen de maker beheert.</p>
            </div>
            <div className="flex gap-2 items-center">
              <span className="text-sm text-slate-500">Ingelogd als</span>
              <Input className="w-40" value={root.currentUser.name} onChange={(e)=>{ const val = e.target.value; const cu = { ...root.currentUser, name: val }; setRoot({ ...root, currentUser: cu }); localStorage.setItem("scoreboard-user", JSON.stringify(cu)); }} />
              <Badge variant="secondary" title={root.currentUser.id}>ID…{root.currentUser.id.slice(-4)}</Badge>
              <Button variant="secondary" onClick={exportAll}><Download className="h-4 w-4 mr-2"/>Export alles</Button>
              <label className="inline-flex">
                <input type="file" accept="application/json" className="hidden" onChange={(e)=> e.target.files?.[0] && importAll(e.target.files[0])} />
                <Button variant="outline" asChild><span><Upload className="h-4 w-4 mr-2"/>Import alles</span></Button>
              </label>
            </div>
          </div>

          <NewBoardForm onCreate={addBoard} />

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
            {root.boards.map((b) => (
              <Card key={b.id} className="hover:shadow-md transition">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-lg">
                    <span className="truncate" title={b.name}>{b.name}</span>
                    <span className="text-xs text-slate-400">{b.state.players.length} spelers</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-2">
                  <Button className="w-full" onClick={() => selectBoard(b.id)}><DoorOpen className="h-4 w-4 mr-2"/>Openen</Button>
                  <InlineRename name={b.name} onSave={(n)=>renameBoard(b.id, n)} />
                  <Button variant="ghost" onClick={()=>{ if(confirm(`Verwijderen: ${b.name}?`)) deleteBoard(b.id); }}><Trash className="h-4 w-4"/></Button>
                </CardContent>
                <div className="px-6 pb-4 flex items-center gap-2 text-xs text-slate-500">
                  <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3"/>Maker</span>
                  <Badge variant="secondary" title={b.ownerId}>ID…{b.ownerId.slice(-4)}</Badge>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**********************
 * Board View (with ownership & sharing controls)
 **********************/
function BoardView({ board, canEdit, currentUser, onBack, onUpdate, onRename, onExport, onCopyLinks, onTransferOwner }: {
  board: Board;
  canEdit: boolean;
  currentUser: { id: string; name: string };
  onBack: () => void;
  onUpdate: (state: BoardState) => void;
  onRename: (name: string) => void;
  onExport: () => void;
  onCopyLinks: () => void;
  onTransferOwner: (newOwnerId: string) => void;
}) {
  const [state, setState] = useState<BoardState>(board.state);
  useEffect(()=>{ onUpdate(state); }, [state]); // eslint-disable-line
  useBroadcast<BoardState>(`scoreboard-${board.id}`, state, (v)=> setState(v));

  const [activityFilter, setActivityFilter] = useState<string>("all");
  const [temp, setTemp] = useState<{ activityId: string; participants: { playerId: string; points: number }[] }>({
    activityId: "",
    participants: [ { playerId: "", points: 0 }, { playerId: "", points: 0 } ],
  });

  const playersById = useMemo(() => Object.fromEntries(state.players.map((p) => [p.id, p])), [state.players]);
  const activitiesById = useMemo(() => Object.fromEntries(state.activities.map((a) => [a.id, a])), [state.activities]);

  // Standings points using win/draw/loss rules (no activity filter here)
  const standingsPerPlayer = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of state.scores) {
      const delta = computeStandingsDelta(s);
      for (const [pid, pts] of delta.entries()) {
        map.set(pid, (map.get(pid) || 0) + pts);
      }
    }
    return map;
  }, [state.scores]);

  const leaderboard = useMemo(() => state.players.map((p)=>({ player: p, points: standingsPerPlayer.get(p.id)||0 })).sort((a,b)=> b.points - a.points), [state.players, standingsPerPlayer]);

  // Actions (guarded by canEdit)
  const addPlayer = (name: string) => canEdit && setState({ ...state, players: [...state.players, { id: uid(), name, photo: null }] });
  const setPlayerPhoto = (playerId: string, dataUrl: string | null) => {
    const players = state.players.map(p => p.id === playerId ? { ...p, photo: dataUrl } : p);
    setState({ ...state, players });
  };
  const addActivity = (name: string) => canEdit && setState({ ...state, activities: [...state.activities, { id: uid(), name }] });
  const addScore = (entry: ScoreEntry) => canEdit && setState({ ...state, scores: [{ ...entry, id: uid(), ts: Date.now() }, ...state.scores] });
  const removeLastScore = () => canEdit && setState({ ...state, scores: state.scores.slice(1) });
  const clearAll = () => canEdit && setState({ ...state, scores: [] });

  // Test cases (runtime assertions)
  useEffect(() => {
    // Normalization tests
    console.assert(JSON.stringify(normalizeParticipants({ id: "1", activityId: "a", ts: 0, playerId: "p1", points: 2 })) === JSON.stringify([{ playerId: "p1", points: 2 }]), "Legacy normalization failed");
    console.assert(JSON.stringify(normalizeParticipants({ id: "2", activityId: "a", ts: 0, participants: [{ playerId: "p1", points: 2 }, { playerId: "p2", points: 4 }] })) === JSON.stringify([{ playerId: "p1", points: 2 }, { playerId: "p2", points: 4 }]), "Participants normalization failed");
    // Scoring tests
    const d1 = computeStandingsDelta({ id: "x", activityId: "a", ts: 0, participants: [{ playerId: "A", points: 1 }, { playerId: "B", points: 0 }] });
    console.assert(d1.get("A") === 2 && !d1.get("B"), "Win should be 2, loss 0");
    const d2 = computeStandingsDelta({ id: "x", activityId: "a", ts: 0, participants: [{ playerId: "A", points: 2 }, { playerId: "B", points: 2 }] });
    console.assert(d2.get("A") === 1 && d2.get("B") === 1, "Draw should be 1 each");
    const d3 = computeStandingsDelta({ id: "x", activityId: "a", ts: 0, participants: [{ playerId: "A", points: 2 }, { playerId: "B", points: 4 }, { playerId: "C", points: 1 }] });
    console.assert(d3.get("B") === 2 && !d3.get("A") && !d3.get("C"), "Single top should get 2");
    const d4 = computeStandingsDelta({ id: "x", activityId: "a", ts: 0, participants: [{ playerId: "A", points: 3 }, { playerId: "B", points: 3 }, { playerId: "C", points: 3 }] });
    console.assert(d4.get("A") === 1 && d4.get("B") === 1 && d4.get("C") === 1, "All tied top should get 1 each");
    // Additional tie test
    const d5 = computeStandingsDelta({ id: "x", activityId: "a", ts: 0, participants: [{ playerId: "A", points: 5 }, { playerId: "B", points: 3 }, { playerId: "C", points: 5 }, { playerId: "D", points: 1 }] });
    console.assert(d5.get("A") === 1 && d5.get("C") === 1 && !d5.get("B") && !d5.get("D"), "Two-way tie at top should give 1 each to winners");
  }, []);

  // Styling helpers
  const podiumStyles = (index: number) => {
    if (index === 0) return "bg-gradient-to-r from-amber-100 to-yellow-50 border-amber-200";
    if (index === 1) return "bg-gradient-to-r from-zinc-100 to-slate-50 border-zinc-200";
    if (index === 2) return "bg-gradient-to-r from-orange-100 to-amber-50 border-orange-200";
    return "hover:bg-slate-50";
  };

  const rankBadge = (index: number) => {
    if (index === 0) return <span className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold bg-amber-500/10 text-amber-700 border border-amber-200"><span>🥇</span>Goud</span>;
    if (index === 1) return <span className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold bg-zinc-500/10 text-zinc-700 border border-zinc-300"><span>🥈</span>Zilver</span>;
    if (index === 2) return <span className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold bg-orange-500/10 text-orange-700 border border-orange-300"><span>🥉</span>Brons</span>;
    return <Badge variant="secondary" className="w-10 justify-center">#{index + 1}</Badge>;
  };

  return (
    <div className="min-h-screen w-full bg-[radial-gradient(1000px_600px_at_50%_-120px,rgba(99,102,241,0.18),transparent)] from-white to-white p-6">
      <div className="mx-auto max-w-6xl">
        <div className="opacity-100 translate-y-0 transition-all">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1"/>Overzicht</Button>
              <h1 className="text-2xl font-bold tracking-tight">{board.name}</h1>
              {canEdit ? (
                <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1"><Unlock className="h-3 w-3"/>Beheer</Badge>
              ) : (
                <Badge className="bg-amber-50 text-amber-700 border border-amber-200 inline-flex items-center gap-1"><Lock className="h-3 w-3"/>Alleen lezen</Badge>
              )}
            </div>
            <div className="flex gap-2">
              <InlineRename name={board.name} onSave={onRename} />
              <Button onClick={onCopyLinks}><Share2 className="h-4 w-4 mr-2"/>Deel links</Button>
              <Button variant="secondary" onClick={onExport}><Download className="h-4 w-4 mr-2"/>Export</Button>
            </div>
          </div>

          <OwnerBar board={board} currentUser={currentUser} onTransferOwner={onTransferOwner} />

          <Tabs defaultValue="leaders" className="w-full">
            <TabsList className="grid w-full grid-cols-4 bg-indigo-50/60 border border-indigo-100">
              <TabsTrigger value="leaders" className="data-[state=active]:bg-white data-[state=active]:text-indigo-700"> <Trophy className="h-4 w-4 mr-2" />Leaderboard</TabsTrigger>
              <TabsTrigger value="add" className="data-[state=active]:bg-white data-[state=active]:text-indigo-700" disabled={!canEdit}><Plus className="h-4 w-4 mr-2" />Score invoeren</TabsTrigger>
              <TabsTrigger value="board" className="data-[state=active]:bg-white data-[state=active]:text-indigo-700"><Table className="h-4 w-4 mr-2" />Scorebord</TabsTrigger>
              <TabsTrigger value="manage" className="data-[state=active]:bg-white data-[state=active]:text-indigo-700" disabled={!canEdit}><Users className="h-4 w-4 mr-2" />Beheer</TabsTrigger>
            </TabsList>

            {/* Leaderboard */}
            <TabsContent value="leaders" className="mt-4">
              <Card className="border-indigo-100">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Trophy className="h-5 w-5 text-amber-500"/>Leaderboard</CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="space-y-3">
                    {leaderboard.map((row, i) => (
                      <li key={row.player.id} className={`flex items-center justify-between rounded-2xl border p-3 transition ${podiumStyles(i)}`}>
                        <div className="flex items-center gap-3">
                          {i < 3 ? (
                            rankBadge(i)
                          ) : (
                            <Badge variant="secondary" className="w-10 justify-center">#{i + 1}</Badge>
                          )}
                          <Avatar name={row.player.name} photo={row.player.photo} size={36} />
                          <span className="font-medium">{row.player.name}</span>
                        </div>
                        <div className="text-right">
                          <div className="text-xs uppercase tracking-wide text-slate-500">Standpunten</div>
                          <div className="text-2xl font-bold">{row.points}</div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Add multi-participant score */}
            <TabsContent value="add" className="mt-4">
              <Card className="border-indigo-100">
                <CardHeader>
                  <CardTitle>Nieuwe score</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid md:grid-cols-3 gap-3">
                    <div className="space-y-2 md:col-span-1">
                      <Label>Activiteit</Label>
                      <Select value={temp.activityId} onValueChange={(v) => setTemp((t) => ({ ...t, activityId: v }))}>
                        <SelectTrigger className="border-indigo-200 focus:ring-indigo-300"><SelectValue placeholder="Kies activiteit" /></SelectTrigger>
                        <SelectContent>
                          {state.activities.map((a) => (<SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <ParticipantsEditor
                    players={state.players}
                    value={temp.participants}
                    onChange={(participants) => setTemp((t)=> ({ ...t, participants }))}
                  />

                  <div className="flex gap-2">
                    <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={!canEdit} onClick={() => {
                      const valid = temp.activityId && temp.participants.length >= 2 && temp.participants.every(p=> p.playerId && Number.isFinite(p.points));
                      const unique = new Set(temp.participants.map(p=>p.playerId)).size === temp.participants.length;
                      if (!valid || !unique) return alert("Controleer activiteit, deelnemers (min 2, uniek) en punten.");
                      addScore({ id: "", activityId: temp.activityId, ts: 0, participants: temp.participants.map(p=> ({ playerId: p.playerId, points: Number(p.points) })) });
                      setTemp({ activityId: "", participants: [ { playerId: "", points: 0 }, { playerId: "", points: 0 } ] });
                    }}>Toevoegen</Button>
                    <Button variant="outline" className="border-amber-200 text-amber-700 hover:bg-amber-50" disabled={!canEdit} onClick={() => setTemp({ activityId: "", participants: [ { playerId: "", points: 0 }, { playerId: "", points: 0 } ] })}><Undo2 className="h-4 w-4 mr-2"/>Reset</Button>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <Button variant="outline" className="border-slate-200" disabled={!canEdit} onClick={removeLastScore}><Undo2 className="h-4 w-4 mr-2" /> Laatste score ongedaan maken</Button>
                    <Button variant="ghost" className="text-red-600 hover:bg-red-50" disabled={!canEdit} onClick={clearAll}><Trash2 className="h-4 w-4 mr-2" /> Alle scores wissen</Button>
                  </div>
                </CardContent>
              </Card>

              <RecentScores scores={state.scores} playersById={playersById} activitiesById={activitiesById} />
            </TabsContent>

            {/* Scoreboard – only match outcomes per activity */}
            <TabsContent value="board" className="mt-4">
              <Card className="border-indigo-100">
                <CardHeader>
                  <SectionTitle icon={Table} title="Scorebord (uitslagen)" right={
                    <div className="flex items-center gap-2">
                      <Label className="text-sm text-slate-500">Activiteit:</Label>
                      <Select value={activityFilter} onValueChange={setActivityFilter}>
                        <SelectTrigger className="w-48 border-indigo-200"><SelectValue placeholder="Alle activiteiten"/></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Alle activiteiten</SelectItem>
                          {state.activities.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  } />
                </CardHeader>
                <CardContent className="space-y-6">
                  <MatchList scores={state.scores} activityFilter={activityFilter} playersById={playersById} activitiesById={activitiesById} />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Manage */}
            <TabsContent value="manage" className="mt-4">
              <div className="grid md:grid-cols-2 gap-4">
                <ManagePlayers players={state.players} onAdd={addPlayer} onSetPhoto={setPlayerPhoto} canEdit={canEdit} />
                <ManageActivities activities={state.activities} onAdd={addActivity} />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function OwnerBar({ board, currentUser, onTransferOwner }: { board: Board; currentUser: { id: string; name: string }; onTransferOwner: (newOwnerId: string) => void }) {
  const isOwner = board.ownerId === currentUser.id;
  const [newOwnerId, setNewOwnerId] = useState("");
  return (
    <div className="mb-4 flex items-center justify-between text-sm">
      <div className="flex items-center gap-2">
        <span className="text-slate-500">Maker:</span>
        <Badge variant="secondary" title={board.ownerId}>ID…{board.ownerId.slice(-4)}</Badge>
      </div>
      <div className="flex items-center gap-2">
        <Input placeholder="Nieuw eigenaar ID" value={newOwnerId} onChange={(e)=> setNewOwnerId(e.target.value)} className="w-48" />
        <Button disabled={!isOwner || !newOwnerId} onClick={()=> onTransferOwner(newOwnerId)}>Eigendom overdragen</Button>
      </div>
    </div>
  );
}

/**********************
 * Participants Editor
 **********************/
function ParticipantsEditor({ players, value, onChange }: { players: Player[]; value: { playerId: string; points: number }[]; onChange: (v: { playerId: string; points: number }[]) => void }) {
  const update = (idx: number, patch: Partial<{ playerId: string; points: number }>) => {
    const next = value.map((row, i) => i === idx ? { ...row, ...patch } : row);
    onChange(next);
  };
  const add = () => onChange([ ...value, { playerId: "", points: 0 } ]);
  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Deelnemers & uitslag</Label>
        <div className="flex gap-2">
          <Button variant="outline" className="border-slate-200" onClick={() => onChange([ { playerId: "", points: 0 }, { playerId: "", points: 0 } ])}>2 spelers</Button>
          <Button variant="outline" className="border-slate-200" onClick={() => onChange([ { playerId: "", points: 0 }, { playerId: "", points: 0 }, { playerId: "", points: 0 } ])}>3 spelers</Button>
          <Button className="bg-blue-600 hover:bg-blue-700 text-white" onClick={add}><Plus className="h-4 w-4 mr-2"/>Speler toevoegen</Button>
        </div>
      </div>

      <div className="grid gap-2">
        {value.map((row, idx) => (
          <div key={idx} className="grid md:grid-cols-3 gap-2 items-end">
            <div className="md:col-span-2">
              <Label className="text-xs">Speler #{idx+1}</Label>
              <Select value={row.playerId} onValueChange={(v) => update(idx, { playerId: v })}>
                <SelectTrigger className="border-slate-200"><SelectValue placeholder="Kies speler" /></SelectTrigger>
                <SelectContent>
                  {players.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Punten</Label>
              <Input type="number" value={row.points} onChange={(e)=> update(idx, { points: Number(e.target.value) })} />
            </div>
            {value.length > 2 && (
              <div className="md:col-span-3 flex justify-end">
                <Button variant="ghost" className="text-red-600 hover:bg-red-50" size="sm" onClick={() => remove(idx)}><X className="h-4 w-4 mr-1"/>Verwijder</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**********************
 * Reusable UI bits
 **********************/
function SectionTitle({ icon: Icon, title, right }: { icon: any; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 text-indigo-500" />
        <h3 className="font-semibold text-lg">{title}</h3>
      </div>
      {right}
    </div>
  );
}

function NewBoardForm({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Card className="border-blue-100">
      <CardHeader><CardTitle>Nieuw leaderboard</CardTitle></CardHeader>
      <CardContent className="flex gap-2">
        <Input placeholder="Naam (bv. Groep 7 trefbal)" value={name} onChange={(e)=> setName(e.target.value)} />
        <Button className="bg-blue-600 hover:bg-blue-700 text-white" onClick={()=> { onCreate(name); setName(""); }}><Plus className="h-4 w-4 mr-2"/>Aanmaken</Button>
      </CardContent>
    </Card>
  );
}

function InlineRename({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  useEffect(()=> setValue(name), [name]);
  if (!editing) return <Button variant="outline" className="border-slate-200" onClick={()=> setEditing(true)}><Edit className="h-4 w-4 mr-2"/>Hernoem</Button>;
  return (
    <div className="flex gap-2">
      <Input value={value} onChange={(e)=> setValue(e.target.value)} className="w-40" />
      <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={()=>{ onSave(value.trim() || name); setEditing(false); }}>Opslaan</Button>
    </div>
  );
}

function Avatar({ name, photo, size = 32 }: { name: string; photo?: string | null; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0,2).map(s=>s[0]?.toUpperCase()||"").join("") || "?";
  const s = { width: size, height: size } as React.CSSProperties;
  if (photo) return <img src={photo} alt={name} style={s} className="rounded-full object-cover border border-white shadow-sm"/>;
  return (
    <div style={s} className="rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold border border-white shadow-sm">
      {initials}
    </div>
  );
}

function ManagePlayers({ players, onAdd, onSetPhoto, canEdit }: { players: Player[]; onAdd: (name: string) => void; onSetPhoto: (playerId: string, dataUrl: string | null) => void; canEdit?: boolean }) {
  const [name, setName] = useState("");

  const handlePick = async (playerId: string, file: File | null) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataURL(file);
      const resized = await resizeImageDataUrl(dataUrl, MAX_PHOTO_SIZE, PHOTO_QUALITY);
      onSetPhoto(playerId, resized);
    } catch (e) {
      alert("Kon afbeelding niet laden/verkleinen.");
    }
  };

  return (
    <Card className="border-indigo-100">
      <CardHeader>
        <SectionTitle icon={Users} title="Spelers" right={
          <div className="flex gap-2">
            <Input placeholder="Naam" value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
            <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" disabled={!canEdit} onClick={() => name.trim() && (onAdd(name.trim()), setName(""))}><Plus className="h-4 w-4 mr-2" />Toevoegen</Button>
          </div>
        } />
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
          {players.map((p) => (
            <li key={p.id} className="rounded-xl border p-3 text-sm flex items-center justify-between hover:bg-slate-50">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar name={p.name} photo={p.photo} />
                <div className="truncate">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-slate-500">ID: {p.id.slice(-4)}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1">
                  <input type="file" accept="image/*" className="hidden" onChange={(e)=> handlePick(p.id, e.target.files?.[0] || null)} />
                  <Button variant="outline" size="sm" disabled={!canEdit}><ImageIcon className="h-4 w-4 mr-1"/>Foto</Button>
                </label>
                {p.photo && (
                  <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50" disabled={!canEdit} onClick={()=> onSetPhoto(p.id, null)}>Verwijder</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-500">Uploads worden automatisch verkleind tot maximaal {MAX_PHOTO_SIZE}px en gecomprimeerd (kwaliteit {Math.round(PHOTO_QUALITY*100)}%).</p>
      </CardContent>
    </Card>
  );
}

function ManageActivities({ activities, onAdd }: { activities: ActivityType[]; onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Card className="border-indigo-100">
      <CardHeader>
        <SectionTitle icon={Activity} title="Activiteiten" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input placeholder="Bijv. Tafeltennis" value={name} onChange={(e) => setName(e.target.value)} />
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={() => name.trim() && (onAdd(name.trim()), setName(""))}><Plus className="h-4 w-4 mr-2" />Toevoegen</Button>
        </div>
        <ul className="grid sm:grid-cols-2 md:grid-cols-3 gap-2">
          {activities.map((a) => (
            <li key={a.id} className="rounded-xl border p-2 text-sm flex items-center justify-between hover:bg-slate-50">
              <span>{a.name}</span>
              <Badge variant="secondary">ID: {a.id.slice(-4)}</Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ScoreTable({ leaderboard, activityFilter }: { leaderboard: { player: Player; points: number }[]; activityFilter: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-2 pr-4">#</th>
            <th className="py-2 pr-4">Speler</th>
            <th className="py-2 pr-4">{activityFilter === "all" ? "Totaal punten" : "Punten (filter)"}</th>
          </tr>
        </thead>
        <tbody>
          {leaderboard.map((row, i) => (
            <tr key={row.player.id} className="border-t">
              <td className="py-2 pr-4">{i + 1}</td>
              <td className="py-2 pr-4 flex items-center gap-2"><Avatar name={row.player.name} photo={row.player.photo} size={20}/>{row.player.name}</td>
              <td className="py-2 pr-4 font-medium">{row.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchList({ scores, activityFilter, playersById, activitiesById }: { scores: ScoreEntry[]; activityFilter: string; playersById: Record<string, Player>; activitiesById: Record<string, ActivityType> }) {
  const filtered = scores.filter(s => activityFilter === "all" || s.activityId === activityFilter);
  return (
    <div>
      <SectionTitle icon={Table} title="Wedstrijden" />
      <Separator className="my-3" />
      {filtered.length === 0 ? (
        <p className="text-sm text-slate-500">Nog geen wedstrijden.</p>
      ) : (
        <ul className="space-y-2">
          {filtered.slice(0, 50).map((s) => {
            const { nameLine, pointsLine } = scoreline(s, playersById);
            const activityName = activitiesById[s.activityId]?.name ?? "?";
            return (
              <li key={s.id} className="rounded-xl border p-3 flex items-center justify-between hover:bg-slate-50">
                <div className="flex items-center gap-2">
                  <Badge className="bg-indigo-50 text-indigo-700 border border-indigo-200">{activityName}</Badge>
                  <span className="font-medium">{nameLine}</span>
                  <span className="text-slate-500">{pointsLine}</span>
                </div>
                <span className="text-xs text-slate-400">{prettyDate(s.ts)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RecentScores({ scores, playersById, activitiesById }: { scores: ScoreEntry[]; playersById: Record<string, Player>; activitiesById: Record<string, ActivityType> }) {
  return (
    <div className="mt-6">
      <SectionTitle icon={Table} title="Recente wedstrijden" />
      <Separator className="my-3" />
      {scores.length === 0 ? (
        <p className="text-sm text-slate-500">Nog geen scores toegevoegd.</p>
      ) : (
        <ul className="space-y-2">
          {scores.slice(0, 10).map((s) => {
            const { nameLine, pointsLine } = scoreline(s, playersById);
            return (
              <li key={s.id} className="rounded-xl border p-3 flex items-center justify-between hover:bg-slate-50">
                <div className="flex items-center gap-2">
                  <Badge className="bg-indigo-50 text-indigo-700 border border-indigo-200">{activitiesById[s.activityId]?.name ?? "?"}</Badge>
                  <span className="font-medium">{nameLine}</span>
                  <span className="text-slate-500">{pointsLine}</span>
                </div>
                <span className="text-xs text-slate-400">{prettyDate(s.ts)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
