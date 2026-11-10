import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({
  systemSpeech: true // AVSpeechSynthesizer, Android TextToSpeech, or the browser's speechSynthesis
});

// The voices on this device. Pass one as `voice` to speak with it.
const voices = await inderun.listVoices({ locale: "de-AT" });

const playback = await inderun.speak({
  text: "Der Bus kommt.",
  locale: "de-AT",
  ...(voices[0] ? { voice: voices[0] } : {}),
  execution: { privacy: "local_required" }
});

// Stop early with `playback.cancel()`. `result` settles when playback ends or is stopped.
const spoken = await playback.result;
console.log(spoken.outcome, spoken.provenance?.providerId);
