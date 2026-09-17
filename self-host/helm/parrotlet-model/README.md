# parrotlet-model Helm chart

One vLLM model per release, OpenAI-compatible on `:8000`, **internal only** (ClusterIP, no ingress). The same chart serves both models; the values file picks which:

```bash
helm install eka-asr               ./helm/parrotlet-model -f helm/parrotlet-model/values-parrotlet-a.yaml
helm install parrotlet-t           ./helm/parrotlet-model -f helm/parrotlet-model/values-parrotlet-t.yaml
helm install eka-structuring-model ./helm/parrotlet-model -f helm/parrotlet-model/values-eka-structuring-model.yaml
```

Then point the apps at them: vaarta `asr.url=http://eka-asr.<ns>.svc:8000/v1`, and for self-hosted structuring `llm.provider=openai_compatible`, `llm.baseUrl=http://eka-structuring-model.<ns>.svc:8000/v1`. Matrix can use the structuring model the same way.

Baked in from production: `/dev/shm` sized by tensor parallel (the 64 MB default hangs model load), Guaranteed QoS, a startup probe sized for model load, **deep liveness that generates a token** (a plain `/health` hid a ~10-hour outage), `IfNotPresent` pulls (a re-pull of 74 GB is an hours-long outage), preStop sleep and a long grace period, `maxSurge 1` (needs a spare GPU during rollouts; set `rollout.maxSurge=0` and `maxUnavailable=1` when there is none).

GPU: NVIDIA Ampere or newer. `gpu.count` = tensor parallel size = GPUs on one node. Fixed replicas by design; no autoscaling.

Requires the NVIDIA device plugin on the cluster. On EKS, `tofu/modules/aws-eks-models` installs it with the GPU node group; on any other cluster without one, install it with `nvidia-device-plugin-values.yaml` from this folder (the command is at the top of that file). EKS Auto Mode has it built in.

parrotlet-a needs the audio marker `<|audio_bos|><audio><|audio_eos|>` in the text prompt next to the `input_audio` part; vaarta's built-in prompt has it. `values-parrotlet-a.yaml` also sets `--mm-processor-cache-type=shm`: without it, one failed audio request leaves vLLM's two audio caches out of step and every later request hangs.

`ekacare/parrotlet_a` is private on Docker Hub: create the `dockerhub` pull secret in the namespace first (see `values-parrotlet-a.yaml`). The image is about 24 GB, so the first start takes 15–25 minutes.

## Checking a release

`helm test <release>` asks the model for one short completion and passes only if it comes back. Nothing runs
during install or upgrade, so it costs a deploy nothing:

```bash
helm test eka-asr -n eka-care --logs
```

For parrotlet-a (`tests.audio: true`) it also sends a generated one-second tone as `input_audio`, carrying the
required marker. That is the check worth having: a ready pod is not a working engine, and the audio path wedges
while text prompts still answer. Turn any of it off with `--set tests.enabled=false`.

What it proves is that the engine answers — not that the answer is any good. Two real results from 16 Sep make
the scope clear: parrotlet-t, which is tuned to emit structured JSON, replies to the bare prompt with `[]`, and
that counts as a pass; and the audio check transcribes a 440 Hz tone into whatever the model imagines, because a
pure tone contains no speech. Both are working engines. Accuracy belongs to the app's own tests, not the chart's.

## Values files

| File | Model | Settings come from | GPU node |
|---|---|---|---|
| `values-parrotlet-a.yaml` | parrotlet-a, speech (release `eka-asr`) | BharatAI production (`bharatai-deployment`, `parrotlet-asr/deployment.yaml`) | one L4, `g6.2xlarge` |
| `values-parrotlet-t.yaml` | parrotlet-t, notes (release `parrotlet-t`), served as `/parrotlet-t/v1` | Eka production (`parrotlet-deployments`, `parrotlet_t/prod-values.yaml`), Docker Hub image with the weights built in | one L4, `g6.2xlarge` |
| `values-eka-structuring-model.yaml` | eka-structuring-model | earlier reference | two GPUs, TP=2 |
