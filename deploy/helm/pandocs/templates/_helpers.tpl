{{- define "pandocs.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "pandocs.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "pandocs.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "pandocs.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "pandocs.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Wrong settings stop at install, not on a running site. */}}
{{- define "pandocs.check" -}}
{{- if not .Values.url -}}
{{- fail "url is required: the address people reach the site at" -}}
{{- end -}}
{{- if not .Values.existingSecret -}}
{{- fail "existingSecret is required: a Secret holding at least DATABASE_URL" -}}
{{- end -}}
{{- if not .Values.storage.s3.bucket -}}
{{- if or (gt (int .Values.replicaCount) 1) .Values.autoscaling.enabled .Values.worker.separate .Values.publish.enabled -}}
{{- fail "storage.s3.bucket is required with more than one pod: pods on different machines have to find the same uploads" -}}
{{- end -}}
{{- end -}}
{{- if .Values.publish.enabled -}}
{{- if not .Values.publish.existingClaim -}}
{{- fail "publish.existingClaim is required: a PersistentVolumeClaim on a shared file system" -}}
{{- end -}}
{{- if not .Values.publish.spaces -}}
{{- fail "publish.spaces is required: anyone with the mount can read what is published, so name them, or use * for all" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* What every kind of pod has in common. `roles` says what this one does. */}}
{{- define "pandocs.pod" -}}
metadata:
  labels:
    {{- include "pandocs.selector" (dict "root" .root "component" .component) | nindent 4 }}
  {{- with .root.Values.podAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  serviceAccountName: {{ include "pandocs.serviceAccount" .root }}
  # Pandocs never talks to Kubernetes, so no pod carries a token for it, whichever account it runs as.
  automountServiceAccountToken: false
  {{- with .root.Values.imagePullSecrets }}
  imagePullSecrets:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  # Long enough to drain and to finish what is in flight. Live event streams then end, and clients reconnect to another pod.
  terminationGracePeriodSeconds: 30
  containers:
    - name: pandocs
      image: "{{ .root.Values.image.repository }}:{{ .root.Values.image.tag | default .root.Chart.AppVersion }}"
      imagePullPolicy: {{ .root.Values.image.pullPolicy }}
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      envFrom:
        - secretRef:
            name: {{ .root.Values.existingSecret }}
      env:
        - name: PANDOCS_URL
          value: {{ .root.Values.url | quote }}
        - name: PANDOCS_ROLES
          value: {{ .roles | quote }}
        - name: PANDOCS_TRUST_PROXY
          value: "true"
        {{- with .root.Values.storage.s3 }}
        {{- if .bucket }}
        - name: PANDOCS_S3_BUCKET
          value: {{ .bucket | quote }}
        - name: PANDOCS_S3_REGION
          value: {{ .region | quote }}
        - name: PANDOCS_S3_PREFIX
          value: {{ .prefix | quote }}
        - name: PANDOCS_S3_FORCE_PATH_STYLE
          value: {{ .forcePathStyle | quote }}
        {{- if .endpoint }}
        - name: PANDOCS_S3_ENDPOINT
          value: {{ .endpoint | quote }}
        {{- end }}
        {{- end }}
        {{- end }}
        {{- range $name, $value := .root.Values.env }}
        - name: {{ $name }}
          value: {{ $value | quote }}
        {{- end }}
        {{- with .extraEnv }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- with .ports }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
      {{- with .probes }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
      {{- with .resources }}
      resources:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      volumeMounts:
        # A read-only root still needs somewhere for temporary files.
        - name: tmp
          mountPath: /tmp
        {{- with .mounts }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
  volumes:
    - name: tmp
      emptyDir: {}
    {{- with .volumes }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- with .root.Values.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .root.Values.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .root.Values.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end -}}
