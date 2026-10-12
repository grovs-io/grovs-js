<script setup>
import { ref } from 'vue';
import GrovsProvider from './GrovsProvider.vue';

const key = ref(0);
const action = ref('');
const answer = ref('');
const report = { action: (value) => (action.value = value), answer: (value) => (answer.value = value) };
</script>

<template>
  <GrovsProvider :key="key" :report="report">
    <RouterView />
  </GrovsProvider>
  <button id="host-remount" type="button" @click="key += 1">Remount provider</button>
  <p>Last action: <span id="host-last-action">{{ action }}</span></p>
  <p>Last answer: <span id="host-last-answer">{{ answer }}</span></p>
</template>
