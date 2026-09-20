import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/ui',timeout:60000,expect:{timeout:12000},fullyParallel:false,workers:1,reporter:[['list'],['html',{open:'never'}]],use:{baseURL:process.env.E2E_BASE_URL??'http://127.0.0.1:4317',trace:'retain-on-failure',screenshot:'only-on-failure',viewport:{width:1440,height:1000}}});
