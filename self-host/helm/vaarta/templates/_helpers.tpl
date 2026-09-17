{{- define "vaarta.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "vaarta.fullname" -}}{{ .Release.Name }}{{- end -}}
{{- define "vaarta.tag" -}}{{ .Values.image.tag }}{{- end -}}
{{- define "vaarta.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag }}{{- end -}}
{{- define "vaarta.workerImage" -}}{{ .Values.image.repository }}:{{ .Values.image.workerTag | default "worker-latest" }}{{- end -}}
{{- define "vaarta.labels" -}}
app.kubernetes.io/name: {{ include "vaarta.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "vaarta.tag" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "vaarta.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vaarta.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "vaarta.selfUrl" -}}
{{- if .Values.config.selfUrl }}{{ .Values.config.selfUrl }}{{ else if .Values.ingress.host }}{{ ternary "https" "http" .Values.ingress.tls.enabled }}://{{ .Values.ingress.host }}{{ else }}http://{{ include "vaarta.fullname" . }}:{{ .Values.service.port }}{{ end }}
{{- end -}}
{{/* AUTH_COOKIE_SECURE. Explicit config.auth.cookieSecure wins; otherwise it follows the scheme of the
     effective public URL, so TLS terminated at an ALB (ingress.tls.enabled=false, selfUrl https://…) still
     gets secure cookies, and plain-HTTP bring-up does not, because browsers drop Secure cookies over HTTP. */}}
{{- define "vaarta.cookieSecure" -}}
{{- $auth := .Values.config.auth | default dict -}}
{{- if and (hasKey $auth "cookieSecure") (ne (toString (index $auth "cookieSecure")) "") -}}
{{- toString (index $auth "cookieSecure") -}}
{{- else -}}
{{- hasPrefix "https://" (include "vaarta.selfUrl" .) -}}
{{- end -}}
{{- end -}}
{{- define "vaarta.secretName" -}}{{ if .Values.secrets.existingSecret }}{{ .Values.secrets.existingSecret }}{{ else if .Values.secrets.create }}{{ .Values.secrets.name }}{{ else }}{{ fail "set secrets.existingSecret or secrets.create=true" }}{{ end }}{{- end -}}
{{- define "vaarta.dbSecretName" -}}{{ default (include "vaarta.secretName" .) .Values.database.existingSecret }}{{- end -}}
{{- define "vaarta.dbHost" -}}{{ if .Values.postgresql.deploy }}{{ include "vaarta.fullname" . }}-postgresql{{ else }}{{ required "database.host is required when postgresql.deploy=false" .Values.database.host }}{{ end }}{{- end -}}
{{- define "vaarta.s3Endpoint" -}}{{ if .Values.minio.deploy }}http://{{ include "vaarta.fullname" . }}-minio:9000{{ else }}{{ .Values.storage.s3.endpointUrl }}{{ end }}{{- end -}}
{{- define "vaarta.s3SecretName" -}}{{ if .Values.storage.s3.existingSecret }}{{ .Values.storage.s3.existingSecret }}{{ else if .Values.minio.deploy }}{{ include "vaarta.secretName" . }}{{ end }}{{- end -}}
{{- define "vaarta.asrUrl" -}}{{ default (printf "http://eka-asr.%s.svc:8000/v1" .Release.Namespace) .Values.asr.url }}{{- end -}}

{{/* env shared by api, worker and migrate */}}
{{- define "vaarta.env" -}}
- name: ENV
  value: {{ .Values.config.env | quote }}
- name: SELF_URL
  value: {{ include "vaarta.selfUrl" . | quote }}
- name: DB_BACKEND
  value: postgres
- name: QUEUE_BACKEND
  value: postgres
- name: STATE_BACKEND
  value: postgres
- name: POSTGRES_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "vaarta.dbSecretName" . }}, key: {{ .Values.secrets.keys.dbPassword }} } }
- name: DATABASE_URL
  value: "postgresql://{{ .Values.database.user }}:$(POSTGRES_PASSWORD)@{{ include "vaarta.dbHost" . }}:{{ .Values.database.port }}/{{ .Values.database.name }}"
- name: ECHO_PG_HOST
  value: {{ include "vaarta.dbHost" . | quote }}
- name: ECHO_PG_PORT
  value: {{ .Values.database.port | quote }}
- name: ECHO_PG_DATABASE
  value: {{ .Values.database.name | quote }}
- name: ECHO_PG_USER
  value: {{ .Values.database.user | quote }}
- name: ECHO_PG_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "vaarta.dbSecretName" . }}, key: {{ .Values.secrets.keys.dbPassword }} } }
{{- if (.Values.database).sslmode }}
- name: PGSSLMODE                 # read by libpq, so it covers DATABASE_URL, the queue DSN and psql alike
  value: {{ .Values.database.sslmode | quote }}
{{- end }}
- name: STORAGE_BACKEND
  value: {{ .Values.storage.backend | quote }}
- name: STORAGE_ROOT
  value: /data/storage
- name: LOG_DIR
  value: /data/logs
{{- if eq .Values.storage.backend "s3" }}
{{- if include "vaarta.s3Endpoint" . }}
- name: S3_ENDPOINT_URL
  value: {{ include "vaarta.s3Endpoint" . | quote }}
- name: AWS_REQUEST_CHECKSUM_CALCULATION
  value: when_required
- name: AWS_RESPONSE_CHECKSUM_VALIDATION
  value: when_required
{{- end }}
{{- with .Values.storage.s3 }}
- name: AWS_REGION
  value: {{ .region | quote }}
- name: S3_BUCKET
  value: {{ .vadedBucket | quote }}
- name: S3_VADED_BUCKET_NAME
  value: {{ .vadedBucket | quote }}
- name: S3_NON_VADED_BUCKET_NAME
  value: {{ .nonVadedBucket | quote }}
- name: BLOB_VIA_API
  value: {{ .blobViaApi | quote }}
{{- end }}
{{- end }}
- name: ECHO_DEFAULT_TRANSCRIBER_PROVIDER
  value: {{ .Values.asr.provider | quote }}
- name: ECHO_DEFAULT_TRANSCRIBER_MODEL
  value: {{ .Values.asr.model | quote }}
{{- if eq .Values.asr.provider "model_api" }}
- name: MODEL_API_BASE_URL
  value: {{ include "vaarta.asrUrl" . | quote }}
{{- with .Values.asr.prompt }}
- name: MODEL_API_TRANSCRIBE_PROMPT
  value: {{ . | quote }}
{{- end }}
{{- with .Values.asr.maxTokens }}
- name: MODEL_API_MAX_TOKENS
  value: {{ . | quote }}
{{- end }}
{{- else if eq .Values.asr.provider "openai_compatible" }}
- name: ECHO_TRANSCRIBER_BASE_URL
  value: {{ required "asr.url is required for openai_compatible" .Values.asr.url | quote }}
{{- end }}
{{- with .Values.asr.language }}
- name: ECHO_TRANSCRIBER_LANGUAGE
  value: {{ . | quote }}
{{- end }}
- name: ECHO_DEFAULT_LLM_PROVIDER
  value: {{ .Values.llm.provider | quote }}
- name: ECHO_DEFAULT_LLM_MODEL
  value: {{ .Values.llm.model | quote }}
- name: ECHO_DEFAULT_LLM_TEMPERATURE
  value: {{ .Values.llm.temperature | quote }}
{{- if .Values.llm.baseUrl }}
- name: ECHO_LLM_BASE_URL
  value: {{ .Values.llm.baseUrl | quote }}
{{- end }}
- name: STRUCTURING_MODELS
  value: {{ .Values.llm.structuringModels | default .Values.llm.model | quote }}
- name: ECHO_PROMPT_PROVIDER
  value: {{ .Values.config.promptProvider | quote }}
- name: ECHO_PROMPT_DIR
  value: /app/prompts
- name: WORKSPACE_ID
  value: {{ .Values.config.workspaceId | quote }}
- name: AUTH_ISSUER
  value: {{ .Values.config.authIssuer | quote }}
- name: AUTH_COOKIE_SECURE
  value: {{ include "vaarta.cookieSecure" . | quote }}
- name: AUTH_ACCESS_TTL_SECONDS
  value: {{ (.Values.config.auth).accessTtlSeconds | default "3600" | quote }}
- name: AUTH_REFRESH_TTL_SECONDS
  value: {{ (.Values.config.auth).refreshTtlSeconds | default "2592000" | quote }}
- name: AUTH_COOKIE_NAME
  value: {{ (.Values.config.auth).cookieName | default "scribe_session" | quote }}
- name: AUTH_REFRESH_COOKIE_NAME
  value: {{ (.Values.config.auth).refreshCookieName | default "scribe_refresh" | quote }}
- name: BACKGROUND_JOB_CONCURRENCY
  value: {{ .Values.config.backgroundJobConcurrency | default "4" | quote }}
- name: DISCOVERY_SUPPORT_EMAIL
  value: {{ .Values.config.discoverySupportEmail | default "admin@example.com" | quote }}
- name: LOG_LEVEL
  value: {{ .Values.config.logLevel | quote }}
{{- range $k, $v := .Values.config.featureFlags }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- range $k, $v := .Values.config.extraEnv }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{- define "vaarta.envFrom" -}}
- secretRef:
    name: {{ include "vaarta.secretName" . }}
{{- if and (eq .Values.storage.backend "s3") (include "vaarta.s3SecretName" .) (ne (include "vaarta.s3SecretName" .) (include "vaarta.secretName" .)) }}
- secretRef:
    name: {{ include "vaarta.s3SecretName" . }}
{{- end }}
{{- end -}}

{{- define "vaarta.volumes" -}}
- name: storage
{{- if eq .Values.storage.backend "local" }}
  persistentVolumeClaim:
    claimName: {{ include "vaarta.fullname" . }}-storage
{{- else }}
  emptyDir: {}
{{- end }}
- name: logs
  emptyDir: {}
{{- end -}}
{{- define "vaarta.volumeMounts" -}}
- name: storage
  mountPath: /data/storage
- name: logs
  mountPath: /data/logs
{{- end -}}

{{/* keep an existing generated secret value across upgrades: (list <old data map> <key> <length>) */}}
{{- define "vaarta.keep" -}}{{ $o := index . 0 }}{{ $k := index . 1 }}{{ $n := index . 2 }}{{ if hasKey $o $k }}{{ index $o $k | b64dec }}{{ else }}{{ randAlphaNum $n }}{{ end }}{{- end -}}
{{- define "vaarta.serviceAccountName" -}}{{ if (.Values.serviceAccount).create }}{{ default (include "vaarta.fullname" .) (.Values.serviceAccount).name }}{{ else }}{{ default "default" (.Values.serviceAccount).name }}{{ end }}{{- end -}}
{{/* helm test toggles. A missing key counts as enabled, so `helm upgrade --reuse-values` from a chart
     version without a tests: block still renders the tests; only an explicit false turns one off. */}}
{{- define "vaarta.testOn" -}}
{{- $t := (index . 0).Values.tests | default dict -}}
{{- $k := index . 1 -}}
{{- if and (or (not (hasKey $t "enabled")) $t.enabled) (or (not (hasKey $t $k)) (index $t $k)) -}}true{{- end -}}
{{- end -}}
{{- define "vaarta.testImage" -}}
{{- $imgs := ((index . 0).Values.tests | default dict).images | default dict -}}
{{- index $imgs (index . 1) | default (index . 2) -}}
{{- end -}}
