{{- define "vm.fullname" -}}{{ .Release.Name }}{{- end -}}
{{- define "vm.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: model
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "vm.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{/* helm test toggles. Tests run only when someone invokes `helm test`, never during install or upgrade.
     A missing key counts as enabled, so `--reuse-values` from a version without a tests: block still renders. */}}
{{- define "vm.testOn" -}}
{{- $t := (index . 0).Values.tests | default dict -}}
{{- $k := index . 1 -}}
{{- if and (or (not (hasKey $t "enabled")) $t.enabled) (or (not (hasKey $t $k)) (index $t $k)) -}}true{{- end -}}
{{- end -}}
