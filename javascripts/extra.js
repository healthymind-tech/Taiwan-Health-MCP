/* Custom JavaScript for Taiwan ICD10 Health MCP Documentation */

document$.subscribe(function() {
  // Add copy button functionality enhancement
  var codeBlocks = document.querySelectorAll('pre code');
  codeBlocks.forEach(function(block) {
    block.classList.add('hljs');
  });

  // Add external link icons
  var links = document.querySelectorAll('a[href^="http"]');
  links.forEach(function(link) {
    if (!link.hostname.includes(window.location.hostname)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        target.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }
    });
  });
});
