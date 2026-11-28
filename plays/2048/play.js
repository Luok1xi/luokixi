// Luokixi 开源广场试玩：代替原版 js/application.js（原版只有一句 new GameManager(...)）。
// 多做三件事：进度存在带前缀的键里，不和网站别的数据混；?demo=1 时自己玩、不存档（精选里只播不操作）；整块按窗口缩放。
(function () {
  var demo = /[?&]demo=1/.test(location.search);

  function PlayStorage() {
    LocalStorageManager.call(this);
    this.bestScoreKey = 'luokixi.plays.2048.best';
    this.gameStateKey = 'luokixi.plays.2048.state';
    if (demo) this.storage = window.fakeStorage;
  }
  PlayStorage.prototype = Object.create(LocalStorageManager.prototype);
  PlayStorage.prototype.constructor = PlayStorage;

  var box = document.querySelector('.container');
  function fit() {
    box.style.transform = '';
    var s = Math.min(1.25, (window.innerWidth - 24) / box.offsetWidth, (window.innerHeight - 24) / box.offsetHeight);
    box.style.transform = 'scale(' + s + ')';
  }
  window.addEventListener('resize', fit);

  window.requestAnimationFrame(function () {
    fit();
    var game = new GameManager(4, KeyboardInputManager, HTMLActuator, PlayStorage);
    if (!demo) return;
    document.documentElement.classList.add('lk-demo');
    // 自己玩：往下、往左交替，挪不动再往右、往上；结束了就重开
    var flip = false;
    setInterval(function () {
      if (game.isGameTerminated()) { game.restart(); return; }
      var before = JSON.stringify(game.grid.serialize());
      var dirs = (flip = !flip) ? [2, 3, 1, 0] : [3, 2, 1, 0];
      for (var i = 0; i < dirs.length; i++) {
        game.move(dirs[i]);
        if (JSON.stringify(game.grid.serialize()) !== before) return;
      }
    }, 650);
  });
})();
