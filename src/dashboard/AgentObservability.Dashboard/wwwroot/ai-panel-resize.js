window.aiPanelResize = {
    init: function (panel) {
        if (!panel) return;
        const handle = panel.querySelector('.ai-overlay-resize-handle');
        if (!handle) return;

        let startX, startWidth;

        handle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            panel.style.transition = 'none';

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
        });

        function onMouseMove(e) {
            const delta = startX - e.clientX;
            const newWidth = Math.max(320, Math.min(startWidth + delta, window.innerWidth * 0.8));
            panel.style.width = newWidth + 'px';
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            panel.style.transition = '';
        }
    }
};
