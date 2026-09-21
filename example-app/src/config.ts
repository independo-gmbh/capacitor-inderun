/**
 * Defaults and build-time configuration.
 *
 * The env vars mirror the ones the upstream `@independo/inderun-web-demo` uses, so the two
 * demos can be pointed at the same proxy with the same `.env`. Pre-filling the fields also
 * matters on a device: retyping a proxy URL on a phone keyboard every launch is the kind of
 * friction that stops a smoke test from being run.
 */

const env = import.meta.env;

/** OpenAI-compatible proxy endpoint. Left blank, the SDK's default endpoint applies. */
export const DEFAULT_ENDPOINT_URL: string = env.VITE_INDERUN_DEMO_PROXY_URL ?? "";

export const DEFAULT_MODEL: string = env.VITE_INDERUN_OPENAI_MODEL ?? "gpt-5.2";

/**
 * Hugging Face repo id for the Web ONNX Runtime provider, e.g.
 * `onnx-community/LFM2.5-350M-ONNX`.
 *
 * Deliberately an env var rather than a UI toggle. The provider needs the consumer to have
 * installed the optional `@huggingface/transformers` peer dependency and it downloads real
 * weights on first use — several hundred MB — so registering it has to be a decision made
 * before the app starts, not a checkbox someone taps to see what happens. Blank (the
 * default) leaves it unregistered.
 */
export const ONNX_MODEL_ID: string = env.VITE_INDERUN_ONNX_MODEL_ID ?? "";

export const DEFAULT_PROMPT = "Explain deterministic provider routing in two sentences.";
