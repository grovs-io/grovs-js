<script setup>
import { watchEffect } from 'vue';
import { trigger } from './grovs';

const props = defineProps({ title: { type: String, required: true } });
watchEffect(() => {
  document.title = props.title;
});
</script>

<template>
  <main>
    <h1>{{ title }}</h1>
    <input id="host-field" placeholder="Type here" />
    <button id="host-trigger" type="button" @click="trigger">Trigger</button>
    <slot />
  </main>
</template>
