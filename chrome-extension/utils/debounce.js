// Debounce utility — loaded before content.js, available as window.debounce
window.debounce = function debounce(fn, delay) {
  let timer = null;
  function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, delay);
  }
  debounced.cancel = function () {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
};
