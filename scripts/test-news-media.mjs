import test from 'node:test';
import assert from 'node:assert/strict';
import {newsMediaLayout} from '../src/js/news-media.js';
test('portrait news pages keep the full source while landscape photos fill the frame',()=>{
 assert.equal(newsMediaLayout({width:800,height:1131}).fit,'contain');
 assert.equal(newsMediaLayout({width:2048,height:1365}).fit,'cover');
 assert.equal(newsMediaLayout({width:2048,height:1365,fit:'contain'}).fit,'contain');
 assert.equal(newsMediaLayout({width:1600,height:1000},{width:800,height:1131}).fit,'contain');
});
test('focal metadata is honored without accepting CSS or out of range values',()=>{
 assert.equal(newsMediaLayout({focal:'50% 43%'}).position,'50% 43%');
 assert.equal(newsMediaLayout({position:'12.5% 70%'}).position,'12.5% 70%');
 for(const position of ['101% 40%','50% 43%;background:url(https://invalid)','center','-5% 30%'])assert.equal(newsMediaLayout({position}).position,'50% 50%');
 assert.equal(newsMediaLayout({width:Infinity,height:999999}).width,0);
});
