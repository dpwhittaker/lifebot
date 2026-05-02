import { useEffect, useRef, useState } from 'react';
import {
  deleteVoiceprint,
  uploadVoiceprint,
  voiceprintUrl,
  type Person,
} from '../threads/groups';
import { VoiceRecorder } from '../util/voiceRecorder';

const MAX_RECORD_SEC = 12;

type Props = {
  groupId: string;
  person: Person;
  onChange: () => void;
};

export function VoiceprintControl({ groupId, person, onChange }: Props) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop recording at the cap, regardless of user action.
  useEffect(() => {
    if (!recording) return;
    if (elapsed >= MAX_RECORD_SEC) {
      void stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, recording]);

  const start = async () => {
    if (busy || recording) return;
    setBusy(true);
    try {
      const r = new VoiceRecorder();
      await r.start();
      recorderRef.current = r;
      setElapsed(0);
      setRecording(true);
      tickRef.current = setInterval(() => {
        setElapsed((e) => e + 0.1);
      }, 100);
    } catch (e) {
      alert(`Mic permission needed to record voiceprint.\n${e instanceof Error ? e.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!recorderRef.current) return;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    setRecording(false);
    setBusy(true);
    try {
      const wav = await recorderRef.current.stop();
      recorderRef.current = null;
      if (wav.byteLength === 0) return;
      await uploadVoiceprint(groupId, person.id, wav);
      onChange();
    } catch (e) {
      alert(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setElapsed(0);
    }
  };

  const cancel = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    recorderRef.current?.abort();
    recorderRef.current = null;
    setRecording(false);
    setElapsed(0);
  };

  const remove = async () => {
    if (!person.hasVoiceprint) return;
    if (!confirm(`Delete the voiceprint for ${person.name}?`)) return;
    setBusy(true);
    try {
      await deleteVoiceprint(groupId, person.id);
      onChange();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const play = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    // Cache-busting query string so re-records reload.
    const a = new Audio(`${voiceprintUrl(groupId, person.id)}?t=${Date.now()}`);
    audioRef.current = a;
    void a.play();
  };

  if (recording) {
    return (
      <div className="voiceprint-row recording">
        <span className="vp-dot vp-dot-active" />
        <span className="vp-elapsed">{elapsed.toFixed(1)}s / {MAX_RECORD_SEC}s</span>
        <button type="button" className="vp-action vp-stop" onClick={() => void stop()}>
          ⏹ Stop
        </button>
        <button type="button" className="vp-action vp-cancel" onClick={cancel}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="voiceprint-row">
      {person.hasVoiceprint ? (
        <>
          <span className="vp-dot vp-dot-have" title="Voiceprint on file" />
          <button type="button" className="vp-action" onClick={play} disabled={busy}>
            ▶ Play
          </button>
          <button type="button" className="vp-action" onClick={() => void start()} disabled={busy}>
            🎙 Re-record
          </button>
          <button type="button" className="vp-action vp-cancel" onClick={() => void remove()} disabled={busy}>
            Delete
          </button>
        </>
      ) : (
        <button type="button" className="vp-action vp-record" onClick={() => void start()} disabled={busy}>
          🎙 Record voiceprint
        </button>
      )}
    </div>
  );
}
