import { createApp, h } from 'vue';
import { RouterLink, createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import HostPage from './HostPage.vue';

const Home = { render: () => h(HostPage, { title: 'Host home' }, () => h(RouterLink, { id: 'host-second', to: '/second' }, () => 'Second')) };
const Second = { render: () => h(HostPage, { title: 'Second' }, () => h(RouterLink, { id: 'host-home', to: '/' }, () => 'Home')) };

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Home },
    { path: '/second', component: Second },
  ],
});

createApp(App).use(router).mount('#app');
