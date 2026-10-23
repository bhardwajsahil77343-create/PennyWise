(() => {
    const revealSelector = 'main > section, main > div, body > section, body > footer, body > div:not(#toast), .soft-card';
    const elements = document.querySelectorAll(revealSelector);

    if (!('IntersectionObserver' in window)) {
        elements.forEach((element) => element.classList.add('is-visible'));
        return;
    }

    const observer = new IntersectionObserver((entries, currentObserver) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('is-visible');
            currentObserver.unobserve(entry.target);
        });
    }, {
        threshold: 0.12,
        rootMargin: '0px 0px -40px 0px'
    });

    elements.forEach((element, index) => {
        element.classList.add('scroll-reveal');
        element.style.setProperty('--scroll-reveal-delay', `${(index % 4) * 70}ms`);
        observer.observe(element);
    });
})();
