// Host (dsh-llm 0.1.1-rc.2) reads `imagePixelBudget` at runtime as a duck-typed
// admission hint, but the rc.2 type surface does not declare it yet. Augment the
// types so call sites can set the field without `as any` casts.
import type {} from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm" {
    interface LlmModelInfo {
        imagePixelBudget?: number;
    }
    interface LlmResolvedModelInfo {
        imagePixelBudget?: number;
    }
}

export {};
