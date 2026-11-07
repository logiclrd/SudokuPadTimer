// ==UserScript==
// @name         SudokuPad Timer Adjust and Idle Pause
// @namespace    local.sudokupad.timer
// @version      0.3.0
// @description  Adjust elapsed time manually; forgive idle time and pause automatically.
// @match        https://sudokupad.app/*
// @match        https://app.crackingthecryptic.com/sudoku/*
// @match        https://test.crackingthecryptic.com/sudoku/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// ==/UserScript==

// Created by ChatGPT

(() => {
    'use strict';

    // Change these values without using SudokuPad's Settings UI.
    const SETTINGS = Object.freeze({
        idleMinutes: 15,             // Declare the user idle after this long.
        forgiveMinutes: 10,         // At the threshold, subtract this much time.
        checkIntervalMs: 1000       // The callback may be delayed in a sleeping tab.
    });

    const MS_PER_MINUTE = 60_000;
    const PREFIX = '[SudokuPad Timer Adjust]';
    const ID = 'control-timer-adjust';
    let lastActivity = Date.now();
    let idleHandled = false;
    let lastWarning = '';
    let adjustButton = null;
    let panel = null;
    let minutesInput = null;
    let lastButtonPress = 0;

    // The same initialization condition and retry pattern used by SudokuPad Tools.
    function setup() {
        if (typeof Framework === 'function' &&
            Framework.app && typeof Framework.app === 'object') {
            initialize();
        } else {
            setTimeout(setup, 100);
        }
    }

    function app() {
        return typeof Framework === 'function' ? Framework.app : null;
    }

    function timer() {
        // Keep this lookup in one place in case SudokuPad changes the API.
        return app()?.timer ?? null;
    }

    function getStartAccessor(t) {
        if (!t) throw new Error('Framework.app.timer is unavailable.');
        for (const key of ['startTime', 'starttime']) {
            const value = t[key];
            if (value instanceof Date && Number.isFinite(value.getTime())) {
                return {
                    read: () => t[key].getTime(),
                    write: ms => { t[key] = new Date(ms); }
                };
            }
            if (typeof value === 'number' && Number.isFinite(value)) {
                // Handle epoch milliseconds, or epoch seconds if applicable.
                const units = value > 100_000_000_000 ? 1
                    : value > 1_000_000_000 ? 1000 : 0;
                if (!units) continue;
                return {
                    read: () => t[key] * units,
                    write: ms => { t[key] = ms / units; }
                };
            }
        }
        throw new Error('Cannot identify the timer start timestamp. Inspect Framework.app.timer.');
    }

    function setElapsedMinutes(minutes) {
        if (!Number.isFinite(minutes) || minutes < 0)
            throw new Error('Enter a nonnegative number of minutes.');
        const t = timer();
        const accessor = getStartAccessor(t);
        accessor.write(Date.now() - minutes * MS_PER_MINUTE);
        redraw(t);
    }

    function advanceStartMs(milliseconds) {
        if (!(milliseconds > 0)) return;
        const t = timer();
        const accessor = getStartAccessor(t);
        accessor.write(Math.min(Date.now(), accessor.read() + milliseconds));
        redraw(t);
    }

    function redraw(t) {
        // Don't assume that a timer has an update method. A running timer
        // ordinarily updates its own display on the next tick.
        if (typeof t?.render === 'function') t.render();
    }

    function warnOnce(message, error) {
        if (message === lastWarning) return;
        lastWarning = message;
        console.warn(PREFIX, message, error ?? '');
    }

    function findPauseButton() {
        // The real game timer is independent of SudokuPad's tool-control bar.
        // Neither the clock button nor its wrapper has an accessible label.
        // The icon switches between play/pause, but the button class is stable.
        return document.querySelector('.game-clock .timer-control > button.timer-playpause');
    }

    function pausedState(t, pauseButton) {
        if (typeof t?.isPaused === 'function') return !!t.isPaused();
        if (typeof t?.isPaused === 'boolean') return t.isPaused;
        if (typeof t?.paused === 'boolean') return t.paused;
        if (typeof t?.isRunning === 'function') return !t.isRunning();
        if (typeof t?.isRunning === 'boolean') return !t.isRunning;
        if (typeof t?.running === 'boolean') return !t.running;
        const clockTitle = pauseButton?.closest('.game-clock')?.getAttribute('title') ?? '';
        if (/\bpaused\b/i.test(clockTitle)) return true;
        if (/\brunning\b/i.test(clockTitle)) return false;
        return null; // Unknown: never toggle blindly.
    }

    function pauseTimer(t, pauseButton, state) {
        if (state === true) return true;
        // A dedicated pause() method is safe even when we cannot read the state.
        if (typeof t?.pause === 'function') {
            t.pause();
            return true;
        }
        if (typeof app()?.pauseTimer === 'function') {
            app().pauseTimer();
            return true;
        }
        // A pause/resume toggle is only safe when we know it is running.
        if (state === false && pauseButton) {
            pauseButton.click();
            return true;
        }
        return false;
    }

    function recordActivity(event) {
        if (event && event.isTrusted === false) return; // Ignore synthetic clicks.
        // A suspended tab may not get its timer callback until the first
        // mouse movement on wake. Account for the gap before resetting it.
        if (!idleHandled && Date.now() - lastActivity >= SETTINGS.idleMinutes * MS_PER_MINUTE)
            checkIdle();
        lastActivity = Date.now();
        idleHandled = false;
    }

    function checkIdle() {
        const idleMs = SETTINGS.idleMinutes * MS_PER_MINUTE;
        const forgiveMs = SETTINGS.forgiveMinutes * MS_PER_MINUTE;
        if (idleHandled || !(idleMs > 0) || forgiveMs < 0) return;
        const now = Date.now();
        const inactiveFor = now - lastActivity;
        if (inactiveFor < idleMs) return;

        const t = timer();
        if (!t) return;
        const pauseButton = findPauseButton();
        const state = pausedState(t, pauseButton);
        if (state === true) {
            idleHandled = true;
            return;
        }
        if (state === null && typeof t.pause !== 'function' &&
            typeof app()?.pauseTimer !== 'function') {
            warnOnce('Cannot determine whether the timer is running; idle pause skipped.');
            return;
        }

        // On-time callback: subtract 10 minutes after 15 minutes idle.
        // Late callback (e.g. after laptop sleep): preserve only the first
        // idleMinutes - forgiveMinutes of the entire idle interval.
        const toForgive = Math.max(0, inactiveFor - (idleMs - forgiveMs));
        try {
            // Validate start timestamp before attempting any changes.
            getStartAccessor(t);
            // Adjust before pausing: the site's pause implementation may
            // snapshot the elapsed time when it stops the clock.
            advanceStartMs(toForgive);
            if (!pauseTimer(t, pauseButton, state)) {
                warnOnce('A usable SudokuPad pause control was not found.');
                return;
            }
            idleHandled = true;
            console.info(PREFIX, `Paused after ${Math.round(inactiveFor / 60000)} minutes idle; ` +
                `forgave ${(toForgive / 60000).toFixed(2)} minutes.`);
        } catch (error) {
            warnOnce('Automatic timer adjustment failed.', error);
        }
    }

    function hidePanel() {
        if (panel) panel.hidden = true;
    }

    function positionPanel() {
        if (!panel || !adjustButton) return;
        const rect = adjustButton.getBoundingClientRect();
        const width = panel.offsetWidth || 158;
        const x = Math.max(4, Math.min(rect.left, innerWidth - width - 4));
        const y = rect.bottom + 4;
        panel.style.left = `${x}px`;
        panel.style.top = `${Math.min(y, innerHeight - panel.offsetHeight - 4)}px`;
    }

    function openPanel() {
        if (!panel) buildPanel();
        if (!panel.hidden) {
            hidePanel();
            return;
        }
        panel.hidden = false;
        minutesInput.value = '';
        positionPanel();
        minutesInput.focus();
    }

    function buildPanel() {
        panel = document.createElement('form');
        panel.id = `${ID}-panel`;
        panel.hidden = true;
        panel.setAttribute('aria-label', 'Set timer minutes');
        panel.innerHTML = `<input type="number" min="0" step="any" inputmode="decimal"
                               placeholder="Minutes" aria-label="Elapsed minutes" required>
                           <button type="submit">OK</button>`;
        Object.assign(panel.style, {
            position: 'fixed', display: 'flex', gap: '4px', alignItems: 'center',
            padding: '6px', background: 'var(--background-color, #272727)',
            color: 'inherit', border: '1px solid #888', borderRadius: '5px',
            boxShadow: '0 3px 10px #0005', zIndex: '2147483647'
        });
        document.body.appendChild(panel);
        minutesInput = panel.querySelector('input');

        panel.addEventListener('submit', event => {
            event.preventDefault();
            event.stopPropagation();
            const text = minutesInput.value.trim();
            const minutes = Number(text);
            if (!text || !Number.isFinite(minutes) || minutes < 0) {
                minutesInput.focus();
                return;
            }
            try {
                setElapsedMinutes(minutes);
                hidePanel();
                console.info(PREFIX, `Set elapsed time to ${minutes} minutes.`);
            } catch (error) {
                warnOnce('Could not set timer elapsed time.', error);
                minutesInput.setCustomValidity(error.message);
                minutesInput.reportValidity();
                minutesInput.setCustomValidity('');
            }
        });

        panel.addEventListener('focusout', () => {
            // Let focus transfer from textbox to OK without closing the form.
            setTimeout(() => {
                if (!panel.contains(document.activeElement)) hidePanel();
            }, 0);
        });
        panel.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                hidePanel();
                adjustButton?.focus();
            }
        });
        // SudokuPad has global keyboard handlers; avoid writing into the grid.
        for (const type of ['keydown', 'keyup', 'keypress']) {
            window.addEventListener(type, event => {
                if (panel?.contains(event.target)) event.stopImmediatePropagation();
            }, true);
        }
        document.addEventListener('pointerdown', event => {
            if (!panel.hidden && !panel.contains(event.target) &&
                !adjustButton?.contains(event.target)) hidePanel();
        }, true);
    }

    function handleAdjustPress(event) {
        // Click works for pointer and keyboard activation without duplicate
        // touch/pointer click handling.
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        if (now - lastButtonPress < 350) return;
        lastButtonPress = now;
        openPanel();
    }

    function bindAdjustButton(button) {
        if (button.__sudokupadTimerAdjustBound) return;
        button.__sudokupadTimerAdjustBound = true;
        button.title = 'Adjust timer (minutes)';
        button.setAttribute('aria-label', 'Adjust timer');
        button.tabIndex = 0;
        button.addEventListener('click', handleAdjustPress);
        // Keep SudokuPad's game-area pointer and keyboard handlers from
        // interpreting presses on our UI as puzzle input.
        for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
            button.addEventListener(type, event => event.stopPropagation());
        }
    }

    function ensureButton() {
        const pause = findPauseButton();
        if (!pause) return;
        const timerControls = pause.parentElement;
        if (!timerControls) return;

        // Do not rehome a tool-bar control: SudokuPad owns and may rebuild
        // that toolbar, and its control DOM does not use timer button styles.
        // Instead create a real button beside the actual pause button with
        // identical CSS classes, but without copying its event listeners.
        let button = document.getElementById(ID);
        if (button && button.tagName !== 'BUTTON') {
            button.remove(); // From a previous version still present in the page.
            button = null;
        }
        if (!button) {
            button = pause.cloneNode(false);
            button.id = ID;
            button.type = 'button';
            button.textContent = '..';
            button.removeAttribute('disabled');
            button.removeAttribute('onclick');
        }
        bindAdjustButton(button);
        timerControls.classList.add('sudokupad-timer-adjust-row');

        // Also repairs placement if SudokuPad rebuilds part of the timer UI.
        if (button.parentElement !== timerControls ||
            button.previousElementSibling !== pause) {
            pause.insertAdjacentElement('afterend', button);
        }
        adjustButton = button;
    }

    function installStyle() {
        if (document.getElementById('sudokupad-timer-adjust-style')) return;
        const style = document.createElement('style');
        style.id = 'sudokupad-timer-adjust-style';
        style.textContent = `
            #${ID}-panel[hidden] { display: none !important; }
            #${ID}-panel input { box-sizing: border-box; width: 96px;
                padding: 4px; color: #111; background: #fff; border: 1px solid #999;
                border-radius: 3px; font-size: 14px; }
            #${ID}-panel button { box-sizing: border-box; padding: 4px 8px;
                font-size: 14px; cursor: pointer; color: #111; background: #eee;
                border: 1px solid #999; border-radius: 3px; }
            .game-clock .timer-control.sudokupad-timer-adjust-row {
                display: inline-flex;
                align-items: center;
                gap: 2px;
                white-space: nowrap;
            }
            .game-clock .timer-control #${ID} {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font: 700 20px/1 sans-serif;
                white-space: nowrap;
            }
        `;
        document.head.appendChild(style);
    }

    function initialize() {
        for (const type of ['mousemove', 'mousedown', 'keydown', 'pointerdown', 'touchstart']) {
            document.addEventListener(type, recordActivity, {capture: true, passive: true});
        }
        // Activity is counted even when a user is interacting with the dialog.
        installStyle();
        ensureButton();
        setInterval(() => {
            ensureButton();
            checkIdle();
        }, SETTINGS.checkIntervalMs);
        window.addEventListener('focus', checkIdle);
        document.addEventListener('visibilitychange', checkIdle);
        console.info(PREFIX, 'Ready.');
    }

    setup();
})();
