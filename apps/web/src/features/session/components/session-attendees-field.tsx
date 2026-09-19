'use client';

import { useEffect, useRef, useState } from 'react';
import { Users, X } from 'lucide-react';
import { useSessionAttendees } from '../hooks/use-session-attendees';

interface SessionAttendeesFieldProps {
  sessionId: string;
  disabled?: boolean;
  onDisabledClick?: () => void;
}

// Mirrors SessionTitleField: borderless once filled, boxed while empty or editing.
const SessionAttendeesField = ({
  sessionId,
  disabled,
  onDisabledClick,
}: SessionAttendeesFieldProps) => {
  const { attendees, saveAttendees, removeAttendees } = useSessionAttendees(sessionId);
  const [draft, setDraft] = useState(attendees);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync when the stored value changes (session load, partner handoff, revert).
  useEffect(() => {
    if (!isEditing) setDraft(attendees);
  }, [attendees, isEditing]);

  const commit = () => {
    setIsEditing(false);
    if (draft.trim() !== attendees) saveAttendees(draft);
  };

  const hasAttendees = !!attendees && !isEditing;

  return (
    <div
      className={`group flex items-center gap-2 flex-1 sm:flex-none sm:w-72 min-w-0 py-1.5 rounded-lg border transition-colors ${
        disabled
          ? 'opacity-60 cursor-not-allowed border-transparent px-3'
          : isEditing
            ? 'bg-white border-[#215FFF] px-3'
            : hasAttendees
              ? 'border-transparent hover:bg-[#F5F8FF] px-2'
              : 'bg-white border-[#D1D1D1] px-3'
      }`}
    >
      <Users className="w-4 h-4 shrink-0 text-[#767676]" />
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder="Add attendees"
        disabled={disabled}
        onFocus={() => setIsEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(attendees);
            setIsEditing(false);
            e.currentTarget.blur();
          }
        }}
        onMouseDown={(e) => {
          if (disabled) {
            e.preventDefault();
            onDisabledClick?.();
          }
        }}
        className={`flex-1 min-w-0 bg-transparent border-none outline-none text-[#1A1A1A] placeholder:text-[#767676] text-sm ${
          disabled ? 'cursor-not-allowed' : 'cursor-text'
        }`}
      />
      {!disabled && hasAttendees && (
        <button
          onMouseDown={(e) => {
            // mousedown (not click) so it wins over the input blur
            e.preventDefault();
            removeAttendees();
          }}
          title="Remove attendees"
          className="shrink-0 p-0.5 rounded-md text-[#767676] opacity-0 group-hover:opacity-100 hover:text-[#D92D20] hover:bg-white cursor-pointer transition-all"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};

export default SessionAttendeesField;
