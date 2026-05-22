window.queryEditor = {
    getCaretCoordinates: function (element) {
        if (!element) return { top: 0, left: 0, cursorPos: 0 };

        const cursorPos = element.selectionStart;
        const text = element.value.substring(0, cursorPos);

        // Create a mirror div to measure text up to cursor
        const mirror = document.createElement('div');
        const computed = getComputedStyle(element);

        mirror.style.position = 'absolute';
        mirror.style.visibility = 'hidden';
        mirror.style.whiteSpace = 'pre-wrap';
        mirror.style.wordWrap = 'break-word';
        mirror.style.width = computed.width;
        mirror.style.font = computed.font;
        mirror.style.padding = computed.padding;
        mirror.style.border = computed.border;
        mirror.style.lineHeight = computed.lineHeight;
        mirror.style.letterSpacing = computed.letterSpacing;

        mirror.textContent = text;

        const span = document.createElement('span');
        span.textContent = '|';
        mirror.appendChild(span);

        document.body.appendChild(mirror);

        const rect = element.getBoundingClientRect();
        const spanRect = span.getBoundingClientRect();
        const mirrorRect = mirror.getBoundingClientRect();

        const top = rect.top + (spanRect.top - mirrorRect.top) - element.scrollTop;
        const left = rect.left + (spanRect.left - mirrorRect.left) - element.scrollLeft;

        document.body.removeChild(mirror);

        return { top: top, left: left, cursorPos: cursorPos };
    },

    insertAtCursor: function (element, text) {
        if (!element) return '';

        const start = element.selectionStart;
        const end = element.selectionEnd;
        const value = element.value;

        // Insert a newline before the text if cursor isn't at line start
        const prefix = (start > 0 && value[start - 1] !== '\n') ? '\n' : '';
        const insertText = prefix + text;

        element.value = value.substring(0, start) + insertText + value.substring(end);
        element.selectionStart = element.selectionEnd = start + insertText.length;
        element.focus();

        // Trigger input event so Blazor binding picks up the change
        element.dispatchEvent(new Event('input', { bubbles: true }));

        return element.value;
    },

    registerKeyHandler: function (element, dotnetRef) {
        if (!element) return;

        element.addEventListener('keydown', function (e) {
            // Ctrl+Space triggers the filter popup
            if (e.ctrlKey && e.code === 'Space') {
                e.preventDefault();
                const coords = window.queryEditor.getCaretCoordinates(element);
                dotnetRef.invokeMethodAsync('OnFilterPopupRequested', coords.top, coords.left, coords.cursorPos);
            }
        });
    },

    unregisterKeyHandler: function (element) {
        // Element removal handles cleanup automatically
    }
};
