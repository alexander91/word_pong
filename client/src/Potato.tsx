/** A small potato. Pure decoration: it sits on the top-left corner of the game screen. */
export default function Potato() {
  return (
    <svg className="potato" viewBox="0 0 64 52" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="potato-skin" cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#e2b77c" />
          <stop offset="60%" stopColor="#c8935a" />
          <stop offset="100%" stopColor="#a5713d" />
        </radialGradient>
      </defs>
      <path
        d="M9 27c-3-11 6-21 19-22 7-1 12 2 18 1 9-1 15 6 15 15 0 6-2 10 0 15 2 7-6 13-16 12-6 0-9-3-15-2-10 2-18-3-20-10-1-4 0-6-1-9z"
        fill="url(#potato-skin)"
        stroke="#8a5a2b"
        strokeWidth="1.5"
      />
      {/* Eyes and specks in the skin. */}
      <g fill="#8a5a2b" opacity="0.75">
        <ellipse cx="21" cy="19" rx="2" ry="1.4" />
        <ellipse cx="42" cy="15" rx="1.6" ry="1.1" />
        <ellipse cx="49" cy="31" rx="2.1" ry="1.4" />
        <ellipse cx="30" cy="36" rx="1.5" ry="1.1" />
        <ellipse cx="15" cy="34" rx="1.3" ry="0.9" />
      </g>
      <ellipse cx="25" cy="14" rx="7" ry="3" fill="#fff" opacity="0.22" transform="rotate(-12 25 14)" />
    </svg>
  );
}
