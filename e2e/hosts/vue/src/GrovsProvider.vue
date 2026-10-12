<script setup>
import { onMounted } from 'vue';
import { startGrovs } from './grovs';

// Configures the SDK when it mounts, the way an app wraps its tree in a provider.
const props = defineProps({ report: { type: Object, required: true } });
onMounted(() => {
  window.__hostMounts = (window.__hostMounts ?? 0) + 1;
  startGrovs(props.report);
});
</script>

<template>
  <slot />
</template>
