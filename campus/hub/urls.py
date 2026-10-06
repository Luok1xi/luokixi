from django.urls import path
from . import api

urlpatterns = [path('api/hub/<path:route>',api.endpoint), path('hub/',api.workbench),
               path('hub/assets/<str:name>',api.client_file)]
