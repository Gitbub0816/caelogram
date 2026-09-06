import { useEffect, useState } from "react";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  UserProfile,
  useAuth,
  useClerk,
} from "@clerk/react";
import App from "./App";
import { Icon } from "./Icon";

export type Identity = {
  signedIn: boolean;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<unknown>;
};
const appearance = {
  variables: {
    colorPrimary: "#d8bc86",
    colorBackground: "#191a1a",
    colorForeground: "#ece9e2",
    colorMutedForeground: "#aaa69e",
    colorInputBackground: "#111213",
    colorInputForeground: "#ece9e2",
    borderRadius: "6px",
    fontFamily: "DM Sans, sans-serif",
  },
  elements: {
    cardBox: { boxShadow: "none", width: "100%" },
    card: { border: "1px solid #333432" },
    formButtonPrimary: { color: "#191a1a" },
    socialButtonsBlockButton: { borderColor: "#55534b", color: "#ece9e2" },
  },
};
function SessionApp() {
  const { isLoaded, isSignedIn, getToken, userId } = useAuth();
  const { signOut } = useClerk();
  const path = window.location.pathname;
  const redirect =
    isLoaded &&
    (isSignedIn && /^\/(sign-in|sign-up)/.test(path)
      ? "/?connect=github"
      : !isSignedIn && path.startsWith("/account")
        ? "/sign-in"
        : "");
  useEffect(() => {
    if (redirect) window.location.replace(redirect);
  }, [redirect]);
  if (!isLoaded)
    return (
      <div className="auth-loading" role="status">
        Opening your workspace…
      </div>
    );
  if (redirect)
    return (
      <div className="auth-loading" role="status">
        Opening your workspace…
      </div>
    );
  if (
    path.startsWith("/sign-in") ||
    path.startsWith("/sign-up") ||
    path.startsWith("/account")
  ) {
    return (
      <div className="auth-page">
        <a className="auth-brand" href="/">
          <Icon /> caelogram
        </a>
        <div className="auth-layout">
          <section>
            <h1>
              {path.startsWith("/account")
                ? "Your account"
                : "Your code.\nYour orbit."}
            </h1>
            <p>
              Sign in to map your repositories, assemble focused context, and
              review every proposed change.
            </p>
            <p className="auth-note">
              Signing in doesn’t share your source code. You choose which
              repositories the GitHub App can access.
            </p>
            <a href="/">Explore the repository demo</a>
          </section>
          <div className="auth-form">
            {path.startsWith("/account") && isSignedIn ? (
              <UserProfile routing="path" path="/account" />
            ) : path.startsWith("/sign-up") ? (
              <SignUp
                routing="path"
                path="/sign-up"
                signInUrl="/sign-in"
                forceRedirectUrl="/?connect=github"
              />
            ) : (
              <SignIn
                routing="path"
                path="/sign-in"
                signUpUrl="/sign-up"
                forceRedirectUrl="/?connect=github"
              />
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <App
      key={userId || "guest"}
      identity={{
        signedIn: Boolean(isSignedIn),
        getToken,
        signOut: () => signOut({ redirectUrl: "/" }),
      }}
    />
  );
}
export default function AuthRoot() {
  const [config, setConfig] = useState<{
    clerkPublishableKey: string;
    local?: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/config", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            "Application configuration unavailable. Reload to retry.",
          );
        setConfig(await r.json());
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  if (error)
    return (
      <div className="auth-loading" role="alert">
        {error}{" "}
        <button className="secondary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  if (!config)
    return (
      <div className="auth-loading" role="status">
        Loading Caelogram…
      </div>
    );
  if (!config.clerkPublishableKey) {
    if (/^\/(sign-in|sign-up|account)/.test(location.pathname))
      return (
        <div className="auth-loading">
          <h1>Sign-in is not configured yet</h1>
          <p>
            Add the Clerk publishable key and issuer to the Worker
            configuration.
          </p>
          <a href="/">Back to the demo</a>
        </div>
      );
    return (
      <App
        publicMode={
          !config.local || !new URLSearchParams(location.search).has("local")
        }
      />
    );
  }
  return (
    <ClerkProvider
      publishableKey={config.clerkPublishableKey}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
      appearance={appearance}
    >
      <SessionApp />
    </ClerkProvider>
  );
}
