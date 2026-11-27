import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({ systemSpeech: true });

// Rate and pitch are relative: 1 is the voice's normal setting. Volume (0 to 1) only
// attenuates this utterance, never the device volume, so only `speak()` takes it.
const playback = await inderun.speak({
  text: "Der Bus kommt.",
  locale: "de-AT",
  controls: {
    speakingRate: { value: 0.8, requirement: "required" },
    pitch: { value: 1.1, requirement: "preferred" }
  },
  playback: { volume: { value: 0.5 } },
  execution: { privacy: "local_required" }
});

// `output.speech.controls` says what each requested control did.
const spoken = await playback.result;
for (const control of spoken.speech?.controls ?? []) {
  console.log(control.id, control.status, control.effective, control.reason);
}
