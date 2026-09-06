export function Icon({ name = "map" }: { name?: string }) {
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
        <>
          <ellipse
            cx="12"
            cy="12"
            rx="10"
            ry="5"
            transform="rotate(-35 12 12)"
          />
          <circle cx="12" cy="12" r="3" />
          <circle cx="19" cy="5" r="1" fill="currentColor" stroke="none" />
        </>
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
