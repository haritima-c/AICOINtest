"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatKit, useChatKit } from "@openai/chatkit-react";
import type { OpenAIChatKit } from "@openai/chatkit-react";
import {
  STARTER_PROMPTS,
  PLACEHOLDER_INPUT,
  GREETING,
  CREATE_SESSION_ENDPOINT,
  WORKFLOW_ID,
  getThemeConfig,
} from "@/lib/config";
import { ErrorOverlay } from "./ErrorOverlay";
import type { ColorScheme } from "@/hooks/useColorScheme";

export type FactAction = {
  type: "save";
  factId: string;
  factText: string;
};

type ChatKitPanelProps = {
  theme: ColorScheme;
  onWidgetAction: (action: FactAction) => Promise<void>;
  onResponseEnd: () => void;
  onThemeRequest: (scheme: ColorScheme) => void;
};

type ErrorState = {
  script: string | null;
  session: string | null;
  integration: string | null;
  retryable: boolean;
};

const isBrowser = typeof window !== "undefined";
const isDev = process.env.NODE_ENV !== "production";

const createInitialErrors = (): ErrorState => ({
  script: null,
  session: null,
  integration: null,
  retryable: false,
});

export function ChatKitPanel({
  theme,
  onWidgetAction,
  onResponseEnd,
  onThemeRequest,
}: ChatKitPanelProps) {
  const chatKitElementRef = useRef<OpenAIChatKit | null>(null);
  const processedFacts = useRef(new Set<string>());
  const isMountedRef = useRef(true);

  // ✅ Store the session_id returned by create-session
  const sessionIdRef = useRef<string | null>(null);
  const isSavingRef = useRef(false);

  const [errors, setErrors] = useState<ErrorState>(() => createInitialErrors());
  const [isInitializingSession, setIsInitializingSession] = useState(true);
  const [widgetInstanceKey, setWidgetInstanceKey] = useState(0);
  const [scriptStatus, setScriptStatus] = useState<"pending" | "ready" | "error">(
    () =>
      isBrowser && window.customElements?.get("openai-chatkit")
        ? "ready"
        : "pending"
  );

  // Read participant IDs from URL params

  const [params, setParams] = useState<URLSearchParams | null>(null);
  const [paramsReady, setParamsReady] = useState(false);

  useEffect(() => {
    setParams(new URLSearchParams(window.location.search));
    setParamsReady(true);
  }, []);

  // To match your Qualtrics iframe URL:
  const prolificId = params?.get("prolificId") ?? null;
  const prolificSystemId = params?.get("prolificSystemId") ?? null; // from Prolific
  const qualtricsId = params?.get("qualtricsId") ?? null;
  const condition = params?.get("cond") ?? null;



  useEffect(() => {
    if (isDev) {
      console.info("[ChatKitPanel] Participant IDs", { prolificId, qualtricsId });
    }
  }, [prolificId, qualtricsId]);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  // ─── Save conversation by passing session_id to our backend ───────────────
  // The backend uses the ChatKit Threads API to fetch the full conversation
  const saveConversation = useCallback(async () => {
    const sessionId = sessionIdRef.current;

    if (isSavingRef.current) return;
    isSavingRef.current = true;
    if (!sessionId) {
      if (isDev) console.warn("[ChatKitPanel] saveConversation: no session ID yet");
      return;
    }

    if (isDev) {
      console.info("[ChatKitPanel] Saving conversation for session:", sessionId);
    }

    try {
      const res = await fetch("/api/fetch-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          prolific_id: prolificId,
          prolific_system_id: prolificSystemId,
          qualtrics_id: qualtricsId,
          condition: condition,   // ← add this
          source_url: window.location.href,    // ← ADD THIS LINE
        }),
      });

      if (!res.ok) {
        console.error(
          "[ChatKitPanel] fetch-conversation failed",
          res.status,
          await res.text()
        );
      } else if (isDev) {
        const data = await res.json() as Record<string, unknown>;
        console.info("[ChatKitPanel] Conversation saved ✅", data);
      }
    } catch (err) {
      console.error("[ChatKitPanel] fetch-conversation error", err);
    } finally {
      isSavingRef.current = false;
    }
  }, [prolificId, qualtricsId]);

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ─── Script loading ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isBrowser) return;
    let timeoutId: number | undefined;

    const handleLoaded = () => {
      if (!isMountedRef.current) return;
      setScriptStatus("ready");
      setErrorState({ script: null });
    };

    const handleError = (event: Event) => {
      console.error("Failed to load chatkit.js", event);
      if (!isMountedRef.current) return;
      setScriptStatus("error");
      const detail = (event as CustomEvent<unknown>)?.detail ?? "unknown error";
      setErrorState({ script: `Error: ${detail}`, retryable: false });
      setIsInitializingSession(false);
    };

    window.addEventListener("chatkit-script-loaded", handleLoaded);
    window.addEventListener("chatkit-script-error", handleError as EventListener);

    if (window.customElements?.get("openai-chatkit")) {
      handleLoaded();
    } else if (scriptStatus === "pending") {
      timeoutId = window.setTimeout(() => {
        if (!window.customElements?.get("openai-chatkit")) {
          handleError(
            new CustomEvent("chatkit-script-error", {
              detail: "ChatKit web component unavailable. Check script URL.",
            })
          );
        }
      }, 5000);
    }

    return () => {
      window.removeEventListener("chatkit-script-loaded", handleLoaded);
      window.removeEventListener(
        "chatkit-script-error",
        handleError as EventListener
      );
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [scriptStatus, setErrorState]);

  // ─── Workflow config check ────────────────────────────────────────────────
  const isWorkflowConfigured = Boolean(
    WORKFLOW_ID && !WORKFLOW_ID.startsWith("wf_replace")
  );

  useEffect(() => {
    if (!isWorkflowConfigured && isMountedRef.current) {
      setErrorState({
        session: "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.",
        retryable: false,
      });
      setIsInitializingSession(false);
    }
  }, [isWorkflowConfigured, setErrorState]);

  // ─── Reset ────────────────────────────────────────────────────────────────
  const handleResetChat = useCallback(() => {
    processedFacts.current.clear();
    sessionIdRef.current = null;
    if (isBrowser) {
      setScriptStatus(
        window.customElements?.get("openai-chatkit") ? "ready" : "pending"
      );
    }
    setIsInitializingSession(true);
    setErrors(createInitialErrors());
    setWidgetInstanceKey((prev) => prev + 1);
  }, []);

  // ─── Session creation ─────────────────────────────────────────────────────
  const getClientSecret = useCallback(
    async (currentSecret: string | null) => {
      if (!isWorkflowConfigured) {
        const detail =
          "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
          setIsInitializingSession(false);
        }
        throw new Error(detail);
      }

      if (isMountedRef.current) {
        if (!currentSecret) setIsInitializingSession(true);
        setErrorState({ session: null, integration: null, retryable: false });
      }

      try {
        const response = await fetch(CREATE_SESSION_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflow: { id: WORKFLOW_ID },
            session: {
              metadata: {
                prolific_id: prolificId,
                qualtrics_response_id: qualtricsId,
              },
            },
            chatkit_configuration: {
              file_upload: { enabled: true },
            },
          }),
        });

        const raw = await response.text();
        let data: Record<string, unknown> = {};
        if (raw) {
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            console.error("Failed to parse create-session response");
          }
        }

        if (!response.ok) {
          throw new Error(
            typeof data?.error === "string" ? data.error : response.statusText
          );
        }

        const clientSecret = data?.client_secret as string | undefined;
        if (!clientSecret) throw new Error("Missing client secret in response");

        // ✅ Capture the session_id so we can fetch the thread later
        const sessionId = data?.session_id as string | undefined;
        if (sessionId) {
          sessionIdRef.current = sessionId;
          if (isDev) console.info("[ChatKitPanel] Session ID stored:", sessionId);
        } else {
          if (isDev) console.warn("[ChatKitPanel] No session_id in response", data);
        }

        if (isMountedRef.current) {
          setErrorState({ session: null, integration: null });
        }

        return clientSecret;
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : "Unable to start ChatKit session.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
        }
        throw error instanceof Error ? error : new Error(detail);
      } finally {
        if (isMountedRef.current && !currentSecret) {
          setIsInitializingSession(false);
        }
      }
    },
    [isWorkflowConfigured, prolificId, qualtricsId, setErrorState]
  );

  // ─── ChatKit setup ────────────────────────────────────────────────────────
  const chatkit = useChatKit({
    api: { getClientSecret },
    theme: {
      colorScheme: theme,
      ...getThemeConfig(theme),
    },
    startScreen: {
      greeting: GREETING,
      prompts: STARTER_PROMPTS,
    },
    composer: {
      placeholder: PLACEHOLDER_INPUT,
      attachments: { enabled: true },
    },
    threadItemActions: {
      feedback: false,
    },

    onThreadChange: () => {
      processedFacts.current.clear();
    },

    // ✅ After every AI response, fetch + save the full conversation
    onResponseEnd: () => {
      void saveConversation();
      onResponseEnd();
    },

    onResponseStart: () => {
      setErrorState({ integration: null, retryable: false });
    },

    onClientTool: async (invocation: {
      name: string;
      params: Record<string, unknown>;
    }) => {
      if (invocation.name === "switch_theme") {
        const requested = invocation.params.theme;
        if (requested === "light" || requested === "dark") {
          onThemeRequest(requested);
          return { success: true };
        }
        return { success: false };
      }

      if (invocation.name === "record_fact") {
        const id = String(invocation.params.fact_id ?? "");
        const text = String(invocation.params.fact_text ?? "");
        if (!id || processedFacts.current.has(id)) return { success: true };
        processedFacts.current.add(id);
        void onWidgetAction({
          type: "save",
          factId: id,
          factText: text.replace(/\s+/g, " ").trim(),
        });
        return { success: true };
      }

      return { success: false };
    },

    onError: ({ error }: { error: unknown }) => {
      console.error("[ChatKitPanel] ChatKit error", error);
    },
  });

  const activeError = errors.session ?? errors.integration;
  const blockingError = errors.script ?? activeError;

  if (!paramsReady) {
    return null; 
  }

  if (paramsReady && !prolificId && !qualtricsId) {
    return (
      <div className="flex h-[90vh] w-full items-center justify-center rounded-2xl bg-white dark:bg-slate-900">
        <div className="text-center p-8">
          <p className="text-lg font-medium text-gray-700 dark:text-gray-300">
            Session could not be started.
          </p>
          <p className="text-sm text-gray-500 mt-2">
            Please access this page through the survey link.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pb-8 flex h-[90vh] w-full rounded-2xl flex-col overflow-hidden bg-white shadow-sm transition-colors dark:bg-slate-900">
      <ChatKit
        key={widgetInstanceKey}
        ref={chatKitElementRef}
        control={chatkit.control}
        className={
          blockingError || isInitializingSession
            ? "pointer-events-none opacity-0"
            : "block h-full w-full"
        }
      />
      <ErrorOverlay
        error={blockingError}
        fallbackMessage={
          blockingError || !isInitializingSession
            ? null
            : "Loading assistant session..."
        }
        onRetry={blockingError && errors.retryable ? handleResetChat : null}
        retryLabel="Restart chat"
      />
    </div>
  );
}
