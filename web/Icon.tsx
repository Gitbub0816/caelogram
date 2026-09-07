export function Icon({ name = "map" }: { name?: string }) {
  const orbitalDots = [
    [2, 12],
    [3.3, 9.5],
    [6.1, 7.4],
    [9.4, 6.1],
    [12, 5.6],
    [14.6, 6.1],
    [17.9, 7.4],
    [20.7, 9.5],
    [22, 12],
    [20.7, 14.5],
    [17.9, 16.6],
    [14.6, 17.9],
    [12, 18.4],
    [9.4, 17.9],
    [6.1, 16.6],
    [3.3, 14.5],
  ];
  const paths: Record<string, string> = {
    context: "M4 5h16M4 12h10M4 19h13",
    history: "M6 5v14m0-9c10 0 12-1 12-5",
    audit: "M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01",
    settings: "M4 7h16M4 17h16M9 4v6M16 14v6",
    plus: "M12 5v14M5 12h14",
    search: "m16 16 5 5",
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "map" ? (
        <g transform="rotate(-35 12 12)" fill="currentColor" stroke="none">
          {orbitalDots.map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r="1.18" />
          ))}
        </g>
      ) : (
        <>
          <path d={paths[name] || paths.context} />
          {name === "history" && (
            <>
              <circle cx="6" cy="4" r="2" />
              <circle cx="6" cy="20" r="2" />
              <circle cx="18" cy="4" r="2" />
            </>
          )}
          {name === "search" && <circle cx="10" cy="10" r="7" />}
        </>
      )}
    </svg>
  );
}
